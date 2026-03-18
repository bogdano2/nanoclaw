/**
 * Clarify MCP Stdio Server — runs inside the container and proxies to the
 * host's Clarify HTTP proxy. Gives the agent CRM tools for companies,
 * people, deals, tasks, and meetings.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (msg: string) =>
  process.stderr.write(`[clarify-mcp] ${msg}\n`);

const PROXY_HOST = process.env.CLARIFY_PROXY_HOST || 'host.docker.internal';
const PROXY_PORT = process.env.CLARIFY_PROXY_PORT;

if (!PROXY_PORT) {
  log('CLARIFY_PROXY_PORT not set — server cannot start');
  process.exit(1);
}

const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}/exec`;

async function clarifyExec(
  tool: string,
  args: Record<string, unknown>,
  workspace = 'cleanerdns',
): Promise<string> {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args, workspace }),
  });
  const data = (await res.json()) as {
    status: string;
    output?: string;
    error?: string;
  };
  if (data.status === 'error') {
    return `Error: ${data.error}`;
  }
  return data.output || '';
}

const server = new McpServer({
  name: 'clarify',
  version: '1.0.0',
});

// --- Query tool ---

server.tool(
  'clarify_query',
  'Query Clarify CRM data using SQL. Entities: company, person, deal, task, meeting. Use JSONB operators for nested fields.',
  {
    entity: z.string().describe('Entity type: company, person, deal, task, meeting'),
    sql: z.string().describe('SQL query (no LIMIT/OFFSET — pagination handled automatically)'),
    workspace: z.enum(['cleanerdns', 'appthrive']).default('cleanerdns')
      .describe('Clarify workspace: cleanerdns (CleanerDNS/Quad9) or appthrive (AppThrive/AppEsteem)'),
  },
  async ({ entity, sql, workspace }) => {
    const output = await clarifyExec('query-data', {
      entity,
      sql,
      tool_label: 'agent query',
    }, workspace);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

// --- Create record ---

server.tool(
  'clarify_create',
  'Create a record in Clarify CRM (company, person, deal, task)',
  {
    entity: z.string().describe('Entity type: company, person, deal, task'),
    attributes: z.record(z.string(), z.unknown()).describe('Field values: {title, status, priority, due_date, ...}'),
    relationships: z.array(z.object({
      relationshipFieldName: z.string(),
      right: z.array(z.object({
        entity: z.string(),
        _id: z.string(),
      })),
    })).optional().describe('Relationships to link: [{relationshipFieldName: "company_id", right: [{entity: "company", _id: "..."}]}]'),
    workspace: z.enum(['cleanerdns', 'appthrive']).default('cleanerdns'),
  },
  async ({ entity, attributes, relationships, workspace }) => {
    const args: Record<string, unknown> = { entity, attributes };
    if (relationships) args.relationships = relationships;
    const output = await clarifyExec('create-record', args, workspace);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

// --- Update record ---

server.tool(
  'clarify_update',
  'Update a record in Clarify CRM by ID',
  {
    entity: z.string().describe('Entity type: company, person, deal, task'),
    id: z.string().describe('Record ID (UUID)'),
    attributes: z.record(z.string(), z.unknown()).describe('Fields to update'),
    relationships: z.array(z.object({
      relationshipFieldName: z.string(),
      right: z.array(z.object({
        entity: z.string(),
        _id: z.string(),
      })),
    })).optional().describe('Relationships to update'),
    workspace: z.enum(['cleanerdns', 'appthrive']).default('cleanerdns'),
  },
  async ({ entity, id, attributes, relationships, workspace }) => {
    const args: Record<string, unknown> = { entity, id, attributes };
    if (relationships) args.relationships = relationships;
    const output = await clarifyExec('update-record', args, workspace);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

// --- Add comment ---

server.tool(
  'clarify_comment',
  'Add a comment/note to a Clarify record timeline (company, person, deal, meeting)',
  {
    entity: z.string().describe('Entity type: company, person, deal, meeting'),
    id: z.string().describe('Record ID'),
    message: z.string().describe('Comment text'),
    workspace: z.enum(['cleanerdns', 'appthrive']).default('cleanerdns'),
  },
  async ({ entity, id, message, workspace }) => {
    const output = await clarifyExec('add-comment', { entity, id, message }, workspace);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

// --- Get schema ---

server.tool(
  'clarify_schema',
  'Get the Clarify schema for an entity (to know available fields before querying or creating records)',
  {
    entities: z.array(z.string()).optional().describe('Entity types to get schema for, e.g. ["task", "company"]'),
    format: z.enum(['read', 'write']).default('read').describe('read = SQL query fields, write = create/update fields'),
    workspace: z.enum(['cleanerdns', 'appthrive']).default('cleanerdns'),
  },
  async ({ entities, format, workspace }) => {
    const args: Record<string, unknown> = { format, tool_label: 'schema' };
    if (entities) args.entities = entities;
    const output = await clarifyExec('get-schema', args, workspace);
    return { content: [{ type: 'text' as const, text: output }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log('Clarify MCP server connected');
