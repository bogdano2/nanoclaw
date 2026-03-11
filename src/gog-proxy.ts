/**
 * GOG Proxy — exposes the host's `gog` CLI to container agents via HTTP.
 *
 * Containers can't access macOS Keychain, so gog runs on the host and
 * this proxy accepts JSON requests and returns gog CLI output.
 *
 * POST /exec  { "args": ["gmail", "search", "is:unread", "--account=x", "--json"] }
 * → { "status": "ok", "output": "..." } or { "status": "error", "error": "..." }
 */
import { createServer, Server } from 'http';
import { execFile } from 'child_process';
import path from 'path';
import { logger } from './logger.js';

import { readEnvFile } from './env.js';

const GOG_BIN = process.env.GOG_BIN || '/opt/homebrew/bin/gog';
const gogSecrets = readEnvFile(['GOG_KEYRING_PASSWORD']);

// Allowed top-level gog commands (prevent arbitrary execution)
const ALLOWED_COMMANDS = new Set([
  'gmail',
  'calendar',
  'contacts',
  'tasks',
  'drive',
  'docs',
  'sheets',
  'people',
]);

export function startGogProxy(
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
        let args: string[];
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          args = body.args;
          if (!Array.isArray(args) || args.length === 0) {
            throw new Error('args must be a non-empty array');
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              error: `Bad request: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
          return;
        }

        // Validate the top-level command
        const cmd = args[0];
        if (!ALLOWED_COMMANDS.has(cmd)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              error: `Command "${cmd}" not allowed. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`,
            }),
          );
          return;
        }

        // Always add --no-input and --json for consistent output
        const fullArgs = [...args];
        if (!fullArgs.includes('--no-input')) fullArgs.push('--no-input');

        // Run gog with HOME pointing to store/ so it finds config and
        // file-based keyring tokens in store/Library/Application Support/gogcli/
        const gogHome =
          process.env.GOG_HOME || path.join(process.cwd(), 'store');

        execFile(
          GOG_BIN,
          fullArgs,
          {
            timeout: 30_000,
            maxBuffer: 5 * 1024 * 1024,
            env: {
              ...process.env,
              HOME: gogHome,
              GOG_KEYRING_PASSWORD:
                gogSecrets.GOG_KEYRING_PASSWORD ||
                process.env.GOG_KEYRING_PASSWORD ||
                '',
            },
          },
          (err, stdout, stderr) => {
            if (err) {
              logger.debug(
                { args: fullArgs, stderr, code: err.code },
                'gog command failed',
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  status: 'error',
                  error: stderr || err.message,
                  output: stdout,
                }),
              );
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', output: stdout }));
          },
        );
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'GOG proxy started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
