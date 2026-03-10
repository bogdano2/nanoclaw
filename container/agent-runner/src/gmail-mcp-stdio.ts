/**
 * Gmail MCP Server for NanoClaw
 * Provides a send_email tool using the Gmail API with OAuth credentials.
 * Zero dependencies — uses native fetch() (Node 22).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function log(msg: string): void {
  console.error(`[gmail-mcp] ${msg}`);
}

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const FROM = process.env.GMAIL_FROM;

if (!REFRESH_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !FROM) {
  log('Missing Gmail credentials — server cannot start');
  process.exit(1);
}

// Cached access token
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  log('Access token refreshed');
  return cachedToken.token;
}

function buildRfc2822(to: string, subject: string, body: string, cc?: string): string {
  const lines: string[] = [
    `From: ${FROM}`,
    `To: ${to}`,
  ];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  );
  return lines.join('\r\n');
}

function base64url(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const server = new McpServer({
  name: 'gmail',
  version: '1.0.0',
});

server.tool(
  'send_email',
  'Send an email from Bogdan\'s Gmail account. Use for sending emails, follow-ups, introductions, etc.',
  {
    to: z.string().describe('Recipient email address(es), comma-separated for multiple'),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC email address(es), comma-separated'),
  },
  async (args) => {
    try {
      const accessToken = await getAccessToken();
      const raw = buildRfc2822(args.to, args.subject, args.body, args.cc);
      const encoded = base64url(raw);

      const res = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ raw: encoded }),
        },
      );

      if (!res.ok) {
        const text = await res.text();
        log(`Send failed (${res.status}): ${text}`);
        return {
          content: [{ type: 'text' as const, text: `Failed to send email (${res.status}): ${text}` }],
          isError: true,
        };
      }

      const result = (await res.json()) as { id: string; threadId: string };
      log(`Email sent: id=${result.id} threadId=${result.threadId}`);

      return {
        content: [{
          type: 'text' as const,
          text: `Email sent successfully.\nTo: ${args.to}\nSubject: ${args.subject}\nMessage ID: ${result.id}`,
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`send_email error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: `Error sending email: ${msg}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('Gmail MCP server started');
