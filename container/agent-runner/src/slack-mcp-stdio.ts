/**
 * Slack MCP Server for NanoClaw
 * Provides tools to sync, query, and search Slack messages.
 * Uses session tokens (xoxc + d cookie) — no OAuth app needed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import { SlackClient } from './slack-client.js';
import { SlackDB } from './slack-db.js';

const SLACK_DB_PATH = '/workspace/group/slack/slack.db';

function log(msg: string): void {
  console.error(`[slack-mcp] ${msg}`);
}

const token = process.env.SLACK_XOXC_TOKEN;
const cookie = process.env.SLACK_D_COOKIE;

if (!token) {
  log('SLACK_XOXC_TOKEN not set — Slack MCP server cannot start');
  process.exit(1);
}

// Ensure db directory exists
const dbDir = SLACK_DB_PATH.replace(/\/[^/]+$/, '');
fs.mkdirSync(dbDir, { recursive: true });

const client = new SlackClient(token, cookie || '');
const db = new SlackDB(SLACK_DB_PATH);

/**
 * Parse relative time strings like "24h", "7d", "2w" into a Slack timestamp.
 */
function parseRelativeTime(timeStr: string): string | undefined {
  if (!timeStr) return undefined;

  const match = timeStr.match(/^(\d+)([hdwm])$/);
  if (!match) {
    // Try as absolute timestamp
    const date = new Date(timeStr);
    if (!isNaN(date.getTime())) {
      return String(date.getTime() / 1000);
    }
    return undefined;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();
  let ms: number;

  switch (unit) {
    case 'h':
      ms = value * 3600_000;
      break;
    case 'd':
      ms = value * 86400_000;
      break;
    case 'w':
      ms = value * 604800_000;
      break;
    case 'm':
      ms = value * 2592000_000;
      break;
    default:
      return undefined;
  }

  return String((now - ms) / 1000);
}

function formatTs(ts: string): string {
  const date = new Date(parseFloat(ts) * 1000);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

const server = new McpServer({
  name: 'slack',
  version: '1.0.0',
});

// --- Tool: sync_channels ---
server.tool(
  'sync_channels',
  'Fetch all channels and users from Slack API and store in local cache. Run this first to populate the channel/user index. Returns a summary of what was synced.',
  {},
  async () => {
    try {
      log('Syncing channels...');
      const channels = await client.listConversations();
      for (const ch of channels) {
        db.upsertChannel(ch);
      }
      log(`Synced ${channels.length} channels`);

      log('Syncing users...');
      const users = await client.listUsers();
      for (const u of users) {
        db.upsertUser(u);
      }
      log(`Synced ${users.length} users`);

      // Build summary
      const byType: Record<string, number> = {};
      for (const ch of channels) {
        const type = ch.is_im ? 'DM' : ch.is_mpim ? 'Group DM' : ch.is_group ? 'Private' : 'Public';
        byType[type] = (byType[type] || 0) + 1;
      }
      const typeSummary = Object.entries(byType)
        .map(([t, n]) => `${n} ${t}`)
        .join(', ');

      const humanUsers = users.filter((u) => !u.is_bot && !u.deleted).length;

      return {
        content: [
          {
            type: 'text' as const,
            text: `Synced ${channels.length} channels (${typeSummary}) and ${users.length} users (${humanUsers} active humans).`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Sync error: ${msg}`);
      return { content: [{ type: 'text' as const, text: `Sync failed: ${msg}` }], isError: true };
    }
  },
);

// --- Tool: list_channels ---
server.tool(
  'list_channels',
  'List channels from the local cache. Use sync_channels first if the cache is empty. Supports filtering by type and name search.',
  {
    type: z
      .enum(['public_channel', 'private_channel', 'im', 'mpim'])
      .optional()
      .describe('Filter by channel type'),
    search: z.string().optional().describe('Search channel names (partial match)'),
  },
  async (args) => {
    const channels = db.listChannels(args.type, args.search);

    if (channels.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No channels found. Run sync_channels first to populate the cache.',
          },
        ],
      };
    }

    const lines = channels.map((ch) => {
      const archived = ch.is_archived ? ' [archived]' : '';
      const members = ch.member_count != null ? ` (${ch.member_count} members)` : '';
      let name = ch.name;
      if (ch.type === 'im' && ch.dm_user_id) {
        const userName = db.getUserName(ch.dm_user_id);
        if (userName) name = `DM: ${userName}`;
      }
      return `- ${name} (${ch.type})${members}${archived} [${ch.id}]`;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `${channels.length} channels:\n${lines.join('\n')}`,
        },
      ],
    };
  },
);

// --- Tool: get_messages ---
server.tool(
  'get_messages',
  `Fetch messages for a channel. Uses incremental sync: first call fetches from API, subsequent calls serve from cache unless newer messages are needed.

Accepts channel names (e.g., "general") or IDs. Time can be relative ("24h", "7d", "2w") or absolute ISO date.`,
  {
    channel: z.string().describe('Channel name or ID'),
    since: z
      .string()
      .optional()
      .describe('Fetch messages since this time (e.g., "24h", "7d", "2026-03-01")'),
    limit: z
      .number()
      .optional()
      .default(100)
      .describe('Max messages to return (default 100)'),
    force_refresh: z
      .boolean()
      .optional()
      .default(false)
      .describe('Force re-fetch from API even if cache exists'),
  },
  async (args) => {
    try {
      const channelId = db.resolveChannelName(args.channel);
      if (!channelId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Channel "${args.channel}" not found. Run sync_channels first, then try again with the channel name or ID.`,
            },
          ],
          isError: true,
        };
      }

      const sinceTs = args.since ? parseRelativeTime(args.since) : undefined;
      const cursor = db.getSyncCursor(channelId);

      let fetched = 0;

      // Determine if we need to fetch from API
      const needsFetch =
        args.force_refresh ||
        !cursor ||
        (sinceTs && cursor.oldest_ts && sinceTs < cursor.oldest_ts) ||
        // Re-fetch if last sync was more than 5 minutes ago
        (cursor && Date.now() - new Date(cursor.last_sync_at).getTime() > 300_000);

      if (needsFetch) {
        log(`Fetching messages for ${channelId} from API...`);

        // Determine fetch range
        let fetchOldest = sinceTs;
        let fetchLatest: string | undefined;

        if (cursor && !args.force_refresh) {
          // Incremental: fetch only what's newer than our latest
          if (cursor.latest_ts) {
            fetchOldest = cursor.latest_ts;
          }
        }

        const messages = await client.conversationHistoryAll(
          channelId,
          fetchOldest,
          fetchLatest,
        );

        if (messages.length > 0) {
          fetched = db.upsertMessages(channelId, messages);

          // Update sync cursor
          const timestamps = messages.map((m) => m.ts).sort();
          db.updateSyncCursor(
            channelId,
            timestamps[0],
            timestamps[timestamps.length - 1],
          );

          log(`Stored ${fetched} messages for ${channelId}`);
        } else {
          // Update last_sync_at even if no new messages
          db.updateSyncCursor(channelId, cursor?.oldest_ts || null, cursor?.latest_ts || null);
        }
      }

      // Query from cache
      const messages = db.getMessages(channelId, sinceTs, undefined, args.limit);

      if (messages.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No messages found in channel "${args.channel}"${args.since ? ` since ${args.since}` : ''}.`,
            },
          ],
        };
      }

      // Format messages with user names
      const lines = messages.map((m) => {
        const userName = m.user_id ? db.getUserName(m.user_id) || m.user_id : 'unknown';
        const time = formatTs(m.ts);
        const thread = m.thread_ts && m.thread_ts !== m.ts ? ' [thread reply]' : '';
        const reactions =
          m.reactions_json
            ? ' ' +
              JSON.parse(m.reactions_json)
                .map((r: { name: string; count: number }) => `:${r.name}: ${r.count}`)
                .join(' ')
            : '';
        return `[${time}] ${userName}: ${m.text}${thread}${reactions}`;
      });

      const header = fetched > 0 ? `(fetched ${fetched} new from API)\n` : '(from cache)\n';

      return {
        content: [
          {
            type: 'text' as const,
            text: `${header}${messages.length} messages in "${args.channel}":\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`get_messages error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: `Error fetching messages: ${msg}` }],
        isError: true,
      };
    }
  },
);

// --- Tool: get_threads ---
server.tool(
  'get_threads',
  'Fetch all replies in a thread. Provide the channel and the thread timestamp (thread_ts from a parent message).',
  {
    channel: z.string().describe('Channel name or ID'),
    thread_ts: z.string().describe('Thread timestamp of the parent message'),
  },
  async (args) => {
    try {
      const channelId = db.resolveChannelName(args.channel);
      if (!channelId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Channel "${args.channel}" not found.`,
            },
          ],
          isError: true,
        };
      }

      log(`Fetching thread ${args.thread_ts} in ${channelId}...`);
      const replies = await client.conversationReplies(channelId, args.thread_ts);

      // Cache the replies
      db.upsertMessages(channelId, replies);

      const lines = replies.map((m) => {
        const userName = m.user ? db.getUserName(m.user) || m.user : 'unknown';
        const time = formatTs(m.ts);
        return `[${time}] ${userName}: ${m.text}`;
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `${replies.length} replies in thread:\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`get_threads error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: `Error fetching thread: ${msg}` }],
        isError: true,
      };
    }
  },
);

// --- Tool: get_user_timeline ---
server.tool(
  'get_user_timeline',
  'Get messages from a specific user across all cached channels. Useful for seeing what someone has been saying.',
  {
    user: z.string().describe('User name or ID'),
    since: z
      .string()
      .optional()
      .describe('Messages since this time (e.g., "24h", "7d")'),
    limit: z.number().optional().default(50).describe('Max messages (default 50)'),
  },
  async (args) => {
    const userId = db.resolveUserName(args.user);
    if (!userId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `User "${args.user}" not found. Run sync_channels first to populate the user index.`,
          },
        ],
        isError: true,
      };
    }

    const sinceTs = args.since ? parseRelativeTime(args.since) : undefined;
    const messages = db.getUserTimeline(userId, sinceTs, args.limit);

    if (messages.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No cached messages from "${args.user}". Fetch channel messages first with get_messages.`,
          },
        ],
      };
    }

    const userName = db.getUserName(userId) || args.user;
    const lines = messages.map((m) => {
      const time = formatTs(m.ts);
      const channel = m.channel_name || m.channel_id;
      return `[${time}] #${channel}: ${m.text}`;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `${messages.length} messages from ${userName}:\n\n${lines.join('\n')}`,
        },
      ],
    };
  },
);

// --- Tool: search_messages ---
server.tool(
  'search_messages',
  'Text search across all cached Slack messages. Searches message text with optional channel and user filters.',
  {
    query: z.string().describe('Text to search for'),
    channel: z.string().optional().describe('Limit search to a channel (name or ID)'),
    user: z.string().optional().describe('Limit search to messages from a user (name or ID)'),
    since: z.string().optional().describe('Only messages since this time (e.g., "7d")'),
    limit: z.number().optional().default(50).describe('Max results (default 50)'),
  },
  async (args) => {
    const channelId = args.channel ? db.resolveChannelName(args.channel) : undefined;
    const userId = args.user ? db.resolveUserName(args.user) : undefined;
    const sinceTs = args.since ? parseRelativeTime(args.since) : undefined;

    if (args.channel && !channelId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Channel "${args.channel}" not found.`,
          },
        ],
        isError: true,
      };
    }

    if (args.user && !userId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `User "${args.user}" not found.`,
          },
        ],
        isError: true,
      };
    }

    const results = db.searchMessages(
      args.query,
      channelId || undefined,
      userId || undefined,
      sinceTs,
      args.limit,
    );

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No messages matching "${args.query}". Make sure channels have been synced with get_messages first.`,
          },
        ],
      };
    }

    const lines = results.map((m) => {
      const time = formatTs(m.ts);
      const channel = m.channel_name || m.channel_id;
      const user = m.user_name || m.user_id || 'unknown';
      return `[${time}] #${channel} | ${user}: ${m.text}`;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `${results.length} results for "${args.query}":\n\n${lines.join('\n')}`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
log('Slack MCP server started');
