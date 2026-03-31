/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    script: z.string().optional().describe('Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    script: z.string().optional().describe('New script for the task. Set to empty string to remove the script.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- BD Task tools ---
// Read operations use the SQLite DB directly (read-only mount).
// Write operations go through IPC files (host picks them up).

import Database from 'better-sqlite3';

let _readDb: Database.Database | null = null;
function getReadDb(): Database.Database {
  if (!_readDb) {
    const dbPath = '/workspace/project/store/messages.db';
    _readDb = new Database(dbPath, { readonly: true });
    _readDb.function('EXP', (x: unknown) => Math.exp(Number(x)));
  }
  return _readDb;
}

const BD_PRIORITY_SQL = `
  MIN(100, MAX(0,
    t.base_priority
    + MIN(25, COALESCE((
        SELECT SUM(
          (s.weight / 100.0) * 25.0 * EXP(-1.0 * (julianday('now') - julianday(s.created_at)) / 7.0)
        )
        FROM bd_task_signals s
        WHERE s.task_id = t.id
          AND julianday('now') - julianday(s.created_at) <= 14
      ), 0))
    + CASE
        WHEN t.due_date IS NOT NULL AND t.status NOT IN ('done','cancelled') THEN
          CASE
            WHEN julianday(t.due_date) - julianday('now') <= 0 THEN 30
            WHEN julianday(t.due_date) - julianday('now') <= 14 THEN
              30.0 * EXP(-1.0 * (julianday(t.due_date) - julianday('now')) / 3.0)
            ELSE 0
          END
        ELSE 0
      END
    - MIN(20, MAX(0, 0.5 * (julianday('now') - julianday(
        MAX(t.updated_at, COALESCE(t.last_signal_at, t.updated_at))
      ))))
  ))`;

server.tool(
  'bd_create_task',
  `Create a new BD task. Tasks track projects, follow-ups, action items, and deals.

Priority is computed dynamically from: base_priority (manual), signal recency (emails/messages boost related tasks), deadline urgency (exponential ramp), and time decay (untouched tasks drift down). Set base_priority to reflect inherent importance.`,
  {
    title: z.string().describe('Task title — concise, actionable'),
    description: z.string().optional().describe('Detailed description'),
    deal: z.string().optional().describe('Deal/area name (e.g., "CleanerDNS", "AppEsteem", "AppThrive")'),
    contact: z.string().optional().describe('Primary contact name'),
    contact_email: z.string().optional().describe('Contact email'),
    due_date: z.string().optional().describe('Due date as ISO string (e.g., "2026-03-15")'),
    base_priority: z.number().min(0).max(100).optional().describe('Manual priority 0-100 (default 50). 80+ = urgent, 60-79 = important, 40-59 = normal, <40 = low'),
    tags: z.array(z.string()).optional().describe('Tags for categorization (e.g., ["follow-up", "proposal"])'),
    parent_task_id: z.string().optional().describe('Parent task ID for subtasks'),
    notes: z.string().optional().describe('Additional notes, context, links'),
    status: z.enum(['open', 'in_progress', 'waiting']).optional().describe('Initial status (default: open)'),
  },
  async (args) => {
    const taskId = `bd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'bd_create_task',
      taskId,
      title: args.title,
      description: args.description,
      deal: args.deal,
      contact: args.contact,
      contact_email: args.contact_email,
      due_date: args.due_date,
      base_priority: args.base_priority ?? 50,
      tags: args.tags ? JSON.stringify(args.tags) : undefined,
      parent_task_id: args.parent_task_id,
      notes: args.notes,
      status: args.status || 'open',
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `BD task created: ${taskId} — "${args.title}"` }],
    };
  },
);

server.tool(
  'bd_update_task',
  'Update an existing BD task. Only provided fields are changed. Changes are tracked in history.',
  {
    task_id: z.string().describe('Task ID to update'),
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(['open', 'in_progress', 'waiting', 'done', 'cancelled']).optional(),
    base_priority: z.number().min(0).max(100).optional(),
    deal: z.string().optional(),
    contact: z.string().optional(),
    contact_email: z.string().optional(),
    due_date: z.string().optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
    parent_task_id: z.string().optional(),
    reason: z.string().optional().describe('Why the change was made (logged to history)'),
  },
  async (args) => {
    const data: Record<string, unknown> = {
      type: 'bd_update_task',
      taskId: args.task_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.title !== undefined) data.title = args.title;
    if (args.description !== undefined) data.description = args.description;
    if (args.status !== undefined) data.status = args.status;
    if (args.base_priority !== undefined) data.base_priority = args.base_priority;
    if (args.deal !== undefined) data.deal = args.deal;
    if (args.contact !== undefined) data.contact = args.contact;
    if (args.contact_email !== undefined) data.contact_email = args.contact_email;
    if (args.due_date !== undefined) data.due_date = args.due_date;
    if (args.tags !== undefined) data.tags = JSON.stringify(args.tags);
    if (args.notes !== undefined) data.notes = args.notes;
    if (args.parent_task_id !== undefined) data.parent_task_id = args.parent_task_id;
    if (args.reason !== undefined) data.reason = args.reason;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `BD task ${args.task_id} update requested.` }],
    };
  },
);

server.tool(
  'bd_add_signal',
  `Record a signal that affects task priority. Signals decay over 14 days.

Use when: an email arrives from a contact (email_received), you send a follow-up (email_sent), someone mentions a deal in chat (message_mention), a meeting occurs (meeting), Bogdan says "bump this" (manual_bump), or deal status changes (deal_update).

Higher weight = stronger priority boost (1-100, default 10).`,
  {
    task_id: z.string().describe('Task ID to add signal to'),
    signal_type: z.enum(['email_received', 'email_sent', 'message_mention', 'meeting', 'manual_bump', 'deal_update']),
    source: z.string().optional().describe('Signal origin (e.g., "gmail:thread-abc", "whatsapp:jid")'),
    summary: z.string().optional().describe('Brief description of what happened'),
    weight: z.number().min(1).max(100).optional().describe('Signal strength 1-100 (default 10). 50+ for important signals, 80+ for urgent.'),
  },
  async (args) => {
    const data = {
      type: 'bd_add_signal',
      taskId: args.task_id,
      signal_type: args.signal_type,
      source: args.source,
      summary: args.summary,
      weight: args.weight ?? 10,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Signal (${args.signal_type}, weight=${args.weight ?? 10}) added to task ${args.task_id}.` }],
    };
  },
);

server.tool(
  'bd_list_tasks',
  `Query BD tasks with computed priorities. Tasks are scored dynamically based on base priority, recent signals, deadline urgency, and time decay.

Filters:
- top: highest priority active tasks (default)
- by_deal: filter by deal name (value required)
- by_contact: filter by contact name (value required)
- by_status: filter by status (value required)
- overdue: tasks past their due date
- search: full-text search across title, description, notes, deal, contact`,
  {
    filter: z.enum(['top', 'by_deal', 'by_contact', 'by_status', 'overdue', 'search']).default('top'),
    value: z.string().optional().describe('Filter value — deal name, contact, status, or search query'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (args) => {
    try {
      const rdb = getReadDb();
      const limit = args.limit ?? 20;

      const prioritySql = BD_PRIORITY_SQL;
      let sql: string;
      let params: unknown[];

      switch (args.filter) {
        case 'top':
          sql = `SELECT t.*, ${prioritySql} AS computed_priority FROM bd_tasks t WHERE t.status NOT IN ('done','cancelled') ORDER BY computed_priority DESC LIMIT ?`;
          params = [limit];
          break;
        case 'by_deal':
          sql = `SELECT t.*, ${prioritySql} AS computed_priority FROM bd_tasks t WHERE t.deal = ? AND t.status NOT IN ('done','cancelled') ORDER BY computed_priority DESC LIMIT ?`;
          params = [args.value, limit];
          break;
        case 'by_contact':
          sql = `SELECT t.*, ${prioritySql} AS computed_priority FROM bd_tasks t WHERE t.contact = ? AND t.status NOT IN ('done','cancelled') ORDER BY computed_priority DESC LIMIT ?`;
          params = [args.value, limit];
          break;
        case 'by_status':
          sql = `SELECT t.*, ${prioritySql} AS computed_priority FROM bd_tasks t WHERE t.status = ? ORDER BY computed_priority DESC LIMIT ?`;
          params = [args.value, limit];
          break;
        case 'overdue':
          sql = `SELECT t.*, ${prioritySql} AS computed_priority FROM bd_tasks t WHERE t.due_date IS NOT NULL AND t.due_date < datetime('now') AND t.status NOT IN ('done','cancelled') ORDER BY computed_priority DESC LIMIT ?`;
          params = [limit];
          break;
        case 'search':
          sql = `SELECT t.*, ${prioritySql} AS computed_priority FROM bd_tasks t WHERE (t.title LIKE ? OR t.description LIKE ? OR t.notes LIKE ? OR t.deal LIKE ? OR t.contact LIKE ?) ORDER BY computed_priority DESC LIMIT ?`;
          const pattern = `%${args.value}%`;
          params = [pattern, pattern, pattern, pattern, pattern, limit];
          break;
        default:
          return { content: [{ type: 'text' as const, text: 'Unknown filter.' }], isError: true };
      }

      const tasks = rdb.prepare(sql).all(...params) as Array<Record<string, unknown>>;

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };
      }

      const formatted = tasks.map((t) => {
        const pri = Math.round(t.computed_priority as number);
        const due = t.due_date ? ` | due: ${t.due_date}` : '';
        const deal = t.deal ? ` | ${t.deal}` : '';
        const contact = t.contact ? ` | ${t.contact}` : '';
        return `[${pri}] ${t.id} — ${t.title} (${t.status}${deal}${contact}${due})`;
      }).join('\n');

      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'bd_task_detail',
  'Get full detail for a BD task including signals and change history.',
  {
    task_id: z.string().describe('Task ID'),
  },
  async (args) => {
    try {
      const rdb = getReadDb();

      const task = rdb.prepare(
        `SELECT t.*, ${BD_PRIORITY_SQL} AS computed_priority FROM bd_tasks t WHERE t.id = ?`
      ).get(args.task_id) as Record<string, unknown> | undefined;

      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task ${args.task_id} not found.` }], isError: true };
      }

      const signals = rdb.prepare(
        'SELECT * FROM bd_task_signals WHERE task_id = ? ORDER BY created_at DESC LIMIT 10'
      ).all(args.task_id) as Array<Record<string, unknown>>;

      const history = rdb.prepare(
        'SELECT * FROM bd_task_history WHERE task_id = ? ORDER BY changed_at DESC LIMIT 10'
      ).all(args.task_id) as Array<Record<string, unknown>>;

      let text = `Task: ${task.title}\nID: ${task.id}\nStatus: ${task.status}\nPriority: ${Math.round(task.computed_priority as number)} (base: ${task.base_priority})`;
      if (task.deal) text += `\nDeal: ${task.deal}`;
      if (task.contact) text += `\nContact: ${task.contact}`;
      if (task.due_date) text += `\nDue: ${task.due_date}`;
      if (task.description) text += `\nDescription: ${task.description}`;
      if (task.notes) text += `\nNotes: ${task.notes}`;
      if (task.tags) text += `\nTags: ${task.tags}`;
      text += `\nCreated: ${task.created_at}\nUpdated: ${task.updated_at}`;
      if (task.completed_at) text += `\nCompleted: ${task.completed_at}`;

      if (signals.length > 0) {
        text += '\n\nRecent Signals:';
        for (const s of signals) {
          text += `\n  ${s.created_at} — ${s.signal_type} (weight: ${s.weight})${s.summary ? `: ${s.summary}` : ''}`;
        }
      }

      if (history.length > 0) {
        text += '\n\nChange History:';
        for (const h of history) {
          text += `\n  ${h.changed_at} — ${h.field_changed}: "${h.old_value}" → "${h.new_value}"${h.reason ? ` (${h.reason})` : ''}`;
        }
      }

      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
