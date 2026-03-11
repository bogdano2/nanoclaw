/**
 * Reminders MCP Stdio Server — runs inside the container and proxies to the
 * host's remindctl HTTP proxy. Gives the agent Apple Reminders tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (msg: string) =>
  process.stderr.write(`[reminders-mcp] ${msg}\n`);

const PROXY_HOST = process.env.REMINDERS_PROXY_HOST || 'host.docker.internal';
const PROXY_PORT = process.env.REMINDERS_PROXY_PORT;

if (!PROXY_PORT) {
  log('REMINDERS_PROXY_PORT not set — server cannot start');
  process.exit(1);
}

const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}/exec`;

async function remindctlExec(args: string[]): Promise<string> {
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
  name: 'reminders',
  version: '1.0.0',
});

server.tool(
  'reminders_today',
  'Show reminders due today.',
  {
    json: z.boolean().optional().default(false).describe('Return JSON output for parsing'),
  },
  async ({ json }) => {
    const args = ['today'];
    if (json) args.push('--json');
    const output = await remindctlExec(args);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'reminders_overdue',
  'Show overdue reminders (past their due date).',
  {
    json: z.boolean().optional().default(false),
  },
  async ({ json }) => {
    const args = ['overdue'];
    if (json) args.push('--json');
    const output = await remindctlExec(args);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'reminders_list',
  'List all reminders, or reminders in a specific list.',
  {
    list_name: z.string().optional().describe('Reminder list name (e.g., "CleanerDNS", "AppEsteem"). Omit for all lists.'),
    json: z.boolean().optional().default(false),
  },
  async ({ list_name, json }) => {
    const args = list_name ? ['list', list_name] : ['all'];
    if (json) args.push('--json');
    const output = await remindctlExec(args);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

server.tool(
  'reminders_add',
  `Add a new reminder to Apple Reminders. Syncs to iPhone/iPad/Watch via iCloud.

IMPORTANT: This is for syncing BD tasks to Apple Reminders as a display layer. When creating BD tasks, always use bd_create_task first (SQLite is source of truth), then optionally sync to Reminders for phone visibility.`,
  {
    title: z.string().describe('Reminder title'),
    list: z.string().optional().describe('Reminder list name (e.g., "CleanerDNS", "AppEsteem"). Creates list if needed.'),
    due: z.string().optional().describe('Due date — natural language ("tomorrow", "next monday") or ISO ("2026-03-15 09:00")'),
    notes: z.string().optional().describe('Additional notes'),
  },
  async ({ title, list, due, notes }) => {
    const args = ['add', '--title', title];
    if (list) args.push('--list', list);
    if (due) args.push('--due', due);
    if (notes) args.push('--notes', notes);
    const output = await remindctlExec(args);
    return { content: [{ type: 'text' as const, text: output || 'Reminder added.' }] };
  },
);

server.tool(
  'reminders_complete',
  'Mark a reminder as completed by its ID.',
  {
    ids: z.array(z.string()).describe('One or more reminder IDs to complete'),
  },
  async ({ ids }) => {
    const output = await remindctlExec(['complete', ...ids]);
    return { content: [{ type: 'text' as const, text: output || 'Reminder(s) completed.' }] };
  },
);

server.tool(
  'reminders_delete',
  'Delete a reminder permanently by its ID.',
  {
    id: z.string().describe('Reminder ID to delete'),
  },
  async ({ id }) => {
    const output = await remindctlExec(['delete', id, '--force']);
    return { content: [{ type: 'text' as const, text: output || 'Reminder deleted.' }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('Reminders MCP server connected');
