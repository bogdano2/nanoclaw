/**
 * GOG MCP Stdio Server — runs inside the container and proxies to the
 * host's gog HTTP proxy. Gives the agent Gmail, Calendar, etc. tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (msg: string) =>
  process.stderr.write(`[gog-mcp] ${msg}\n`);

const PROXY_HOST = process.env.GOG_PROXY_HOST || 'host.docker.internal';
const PROXY_PORT = process.env.GOG_PROXY_PORT;

if (!PROXY_PORT) {
  log('GOG_PROXY_PORT not set — server cannot start');
  process.exit(1);
}

const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}/exec`;

async function gogExec(args: string[]): Promise<string> {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  const data = (await res.json()) as {
    status: string;
    output?: string;
    error?: string;
  };
  if (data.status === 'error') {
    return `Error: ${data.error}${data.output ? '\n' + data.output : ''}`;
  }
  return data.output || '';
}

const server = new McpServer({
  name: 'gog',
  version: '1.0.0',
});

// --- Gmail tools ---

server.tool(
  'gmail_search',
  'Search Gmail threads using Gmail query syntax (e.g. "is:unread", "from:alice", "subject:invoice")',
  {
    account: z
      .string()
      .describe(
        'Email address or alias (personal, appthrive, cleanerdns)',
      ),
    query: z.string().describe('Gmail search query'),
    max: z
      .number()
      .optional()
      .default(10)
      .describe('Max results (default 10)'),
  },
  async ({ account, query, max }) => {
    const output = await gogExec([
      'gmail',
      'search',
      query,
      `--account=${account}`,
      '--json',
      `--max=${max}`,
    ]);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'gmail_get',
  'Read a specific email message by ID',
  {
    account: z.string().describe('Email address or alias'),
    id: z.string().describe('Message or thread ID'),
  },
  async ({ account, id }) => {
    const output = await gogExec([
      'gmail',
      'get',
      id,
      `--account=${account}`,
      '--json',
    ]);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'gmail_thread',
  'Read an email thread (all messages in a conversation)',
  {
    account: z.string().describe('Email address or alias'),
    id: z.string().describe('Thread ID'),
  },
  async ({ account, id }) => {
    const output = await gogExec([
      'gmail',
      'thread',
      id,
      `--account=${account}`,
      '--json',
    ]);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'gmail_send',
  'Send an email',
  {
    account: z.string().describe('Email address or alias to send from'),
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC recipients (comma-separated)'),
  },
  async ({ account, to, subject, body, cc }) => {
    const args = [
      'gmail',
      'messages',
      'send',
      `--account=${account}`,
      `--to=${to}`,
      `--subject=${subject}`,
      `--body=${body}`,
      '--json',
    ];
    if (cc) args.push(`--cc=${cc}`);
    const output = await gogExec(args);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

// --- Calendar tools ---

server.tool(
  'calendar_list',
  'List upcoming calendar events',
  {
    account: z.string().describe('Email address or alias'),
    max: z
      .number()
      .optional()
      .default(10)
      .describe('Max results (default 10)'),
  },
  async ({ account, max }) => {
    const output = await gogExec([
      'calendar',
      'list',
      `--account=${account}`,
      '--json',
      `--max=${max}`,
    ]);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'calendar_search',
  'Search calendar events',
  {
    account: z.string().describe('Email address or alias'),
    query: z.string().describe('Search query'),
  },
  async ({ account, query }) => {
    const output = await gogExec([
      'calendar',
      'search',
      query,
      `--account=${account}`,
      '--json',
    ]);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

// --- Generic tool for other gog commands ---

server.tool(
  'gog_command',
  'Run any gog command (gmail, calendar, contacts, tasks, drive, docs, sheets, people). Use this for operations not covered by the specific tools above.',
  {
    args: z
      .array(z.string())
      .describe(
        'Command arguments, e.g. ["gmail", "messages", "list", "--account=work", "--json"]',
      ),
  },
  async ({ args }) => {
    const output = await gogExec(args);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('GOG MCP server connected');
