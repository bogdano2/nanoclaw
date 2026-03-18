/**
 * Clarify CRM Proxy — runs on the host, proxies MCP calls to
 * api.clarify.ai using the local credential tokens.
 * Containers access this via the clarify MCP stdio server.
 */
import { createServer, Server } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from './logger.js';

const MCP_URL = 'https://api.clarify.ai/mcp';
const CRED_DIR = path.join(os.homedir(), '.config', 'mcporter', 'credentials');

interface ClarifyCredential {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  authServer?: string;
}

const WORKSPACE_FILES: Record<string, string> = {
  cleanerdns: 'clarify.json',
  appthrive: 'clarify-appthrive.json',
};

function getToken(workspace: string): string | null {
  const file = WORKSPACE_FILES[workspace];
  if (!file) return null;
  const credPath = path.join(CRED_DIR, file);
  try {
    const cred: ClarifyCredential = JSON.parse(
      fs.readFileSync(credPath, 'utf-8'),
    );
    return cred.accessToken;
  } catch {
    logger.warn({ workspace, credPath }, 'Cannot read Clarify credential');
    return null;
  }
}

async function clarifyCall(
  tool: string,
  args: Record<string, unknown>,
  token: string,
): Promise<{ status: string; output?: string; error?: string }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });

  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });

    const data = (await response.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (data.error) {
      return { status: 'error', error: data.error.message || 'Unknown error' };
    }

    const text = data.result?.content?.[0]?.text || '';
    if (data.result?.isError) {
      return { status: 'error', error: text };
    }
    return { status: 'ok', output: text };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function startClarifyProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/exec') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: {
          tool: string;
          args: Record<string, unknown>;
          workspace?: string;
        };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ status: 'error', error: 'Invalid JSON' }));
          return;
        }

        if (!body.tool || !body.args) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              status: 'error',
              error: 'Missing tool or args',
            }),
          );
          return;
        }

        const workspace = body.workspace || 'cleanerdns';
        const token = getToken(workspace);
        if (!token) {
          res.writeHead(500);
          res.end(
            JSON.stringify({
              status: 'error',
              error: `No token for workspace '${workspace}'`,
            }),
          );
          return;
        }

        clarifyCall(body.tool, body.args, token)
          .then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          })
          .catch((err) => {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                status: 'error',
                error: String(err),
              }),
            );
          });
      });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      logger.info({ port, host }, 'Clarify proxy started');
      resolve(server);
    });
  });
}
