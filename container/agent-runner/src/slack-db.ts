/**
 * SQLite operations for caching Slack data.
 * Uses better-sqlite3 for synchronous operations.
 */

import Database from 'better-sqlite3';
import type { SlackChannel, SlackMessage, SlackUser } from './slack-types.js';

function log(msg: string): void {
  console.error(`[slack-db] ${msg}`);
}

export class SlackDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0,
        topic TEXT,
        purpose TEXT,
        member_count INTEGER,
        dm_user_id TEXT,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        real_name TEXT,
        display_name TEXT,
        email TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        channel_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        user_id TEXT,
        text TEXT NOT NULL,
        thread_ts TEXT,
        subtype TEXT,
        reply_count INTEGER DEFAULT 0,
        reactions_json TEXT,
        files_json TEXT,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (channel_id, ts)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_ts
        ON messages(channel_id, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_user
        ON messages(user_id, ts);
      CREATE INDEX IF NOT EXISTS idx_messages_thread
        ON messages(channel_id, thread_ts);
      CREATE INDEX IF NOT EXISTS idx_messages_text
        ON messages(text);

      CREATE TABLE IF NOT EXISTS sync_cursors (
        channel_id TEXT PRIMARY KEY,
        oldest_ts TEXT,
        latest_ts TEXT,
        last_sync_at TEXT NOT NULL
      );
    `);
    log('Schema initialized');
  }

  // --- Channel operations ---

  upsertChannel(channel: SlackChannel): void {
    let type: string;
    if (channel.is_im) type = 'im';
    else if (channel.is_mpim) type = 'mpim';
    else if (channel.is_group) type = 'private_channel';
    else type = 'public_channel';

    this.db
      .prepare(
        `INSERT INTO channels (id, name, type, is_archived, topic, purpose, member_count, dm_user_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, type=excluded.type, is_archived=excluded.is_archived,
           topic=excluded.topic, purpose=excluded.purpose, member_count=excluded.member_count,
           dm_user_id=excluded.dm_user_id, synced_at=excluded.synced_at`,
      )
      .run(
        channel.id,
        channel.name || channel.id,
        type,
        channel.is_archived ? 1 : 0,
        channel.topic?.value || null,
        channel.purpose?.value || null,
        channel.num_members ?? null,
        channel.user || null,
        new Date().toISOString(),
      );
  }

  listChannels(
    typeFilter?: string,
    nameSearch?: string,
  ): Array<{
    id: string;
    name: string;
    type: string;
    is_archived: number;
    topic: string | null;
    purpose: string | null;
    member_count: number | null;
    dm_user_id: string | null;
  }> {
    let sql = 'SELECT * FROM channels WHERE 1=1';
    const params: string[] = [];

    if (typeFilter) {
      sql += ' AND type = ?';
      params.push(typeFilter);
    }
    if (nameSearch) {
      sql += ' AND name LIKE ?';
      params.push(`%${nameSearch}%`);
    }

    sql += ' ORDER BY name';
    return this.db.prepare(sql).all(...params) as Array<{
      id: string;
      name: string;
      type: string;
      is_archived: number;
      topic: string | null;
      purpose: string | null;
      member_count: number | null;
      dm_user_id: string | null;
    }>;
  }

  resolveChannelName(nameOrId: string): string | null {
    // Try exact ID match first
    const byId = this.db
      .prepare('SELECT id FROM channels WHERE id = ?')
      .get(nameOrId) as { id: string } | undefined;
    if (byId) return byId.id;

    // Try exact name match (case-insensitive)
    const byName = this.db
      .prepare('SELECT id FROM channels WHERE LOWER(name) = LOWER(?)')
      .get(nameOrId) as { id: string } | undefined;
    if (byName) return byName.id;

    // Try partial name match
    const byPartial = this.db
      .prepare('SELECT id FROM channels WHERE LOWER(name) LIKE LOWER(?)')
      .get(`%${nameOrId}%`) as { id: string } | undefined;
    if (byPartial) return byPartial.id;

    return null;
  }

  // --- User operations ---

  upsertUser(user: SlackUser): void {
    this.db
      .prepare(
        `INSERT INTO users (id, name, real_name, display_name, email, is_bot, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, real_name=excluded.real_name, display_name=excluded.display_name,
           email=excluded.email, is_bot=excluded.is_bot, synced_at=excluded.synced_at`,
      )
      .run(
        user.id,
        user.name,
        user.real_name || user.profile?.real_name || null,
        user.profile?.display_name || null,
        user.profile?.email || null,
        user.is_bot ? 1 : 0,
        new Date().toISOString(),
      );
  }

  resolveUserName(nameOrId: string): string | null {
    const byId = this.db
      .prepare('SELECT id FROM users WHERE id = ?')
      .get(nameOrId) as { id: string } | undefined;
    if (byId) return byId.id;

    const byName = this.db
      .prepare(
        `SELECT id FROM users WHERE LOWER(name) = LOWER(?)
         OR LOWER(real_name) = LOWER(?)
         OR LOWER(display_name) = LOWER(?)`,
      )
      .get(nameOrId, nameOrId, nameOrId) as { id: string } | undefined;
    if (byName) return byName.id;

    return null;
  }

  getUserName(userId: string): string | null {
    const row = this.db
      .prepare('SELECT real_name, display_name, name FROM users WHERE id = ?')
      .get(userId) as { real_name: string | null; display_name: string | null; name: string } | undefined;
    if (!row) return null;
    return row.real_name || row.display_name || row.name;
  }

  // --- Message operations ---

  upsertMessage(channelId: string, message: SlackMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (channel_id, ts, user_id, text, thread_ts, subtype, reply_count, reactions_json, files_json, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, ts) DO UPDATE SET
           text=excluded.text, reply_count=excluded.reply_count,
           reactions_json=excluded.reactions_json, files_json=excluded.files_json,
           raw_json=excluded.raw_json`,
      )
      .run(
        channelId,
        message.ts,
        message.user || message.bot_id || null,
        message.text,
        message.thread_ts || null,
        message.subtype || null,
        message.reply_count || 0,
        message.reactions ? JSON.stringify(message.reactions) : null,
        message.files ? JSON.stringify(message.files) : null,
        JSON.stringify(message),
      );
  }

  upsertMessages(channelId: string, messages: SlackMessage[]): number {
    const upsert = this.db.prepare(
      `INSERT INTO messages (channel_id, ts, user_id, text, thread_ts, subtype, reply_count, reactions_json, files_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, ts) DO UPDATE SET
         text=excluded.text, reply_count=excluded.reply_count,
         reactions_json=excluded.reactions_json, files_json=excluded.files_json,
         raw_json=excluded.raw_json`,
    );

    const insertMany = this.db.transaction((msgs: SlackMessage[]) => {
      let count = 0;
      for (const m of msgs) {
        upsert.run(
          channelId,
          m.ts,
          m.user || m.bot_id || null,
          m.text,
          m.thread_ts || null,
          m.subtype || null,
          m.reply_count || 0,
          m.reactions ? JSON.stringify(m.reactions) : null,
          m.files ? JSON.stringify(m.files) : null,
          JSON.stringify(m),
        );
        count++;
      }
      return count;
    });

    return insertMany(messages);
  }

  getMessages(
    channelId: string,
    since?: string,
    until?: string,
    limit = 100,
  ): Array<{
    ts: string;
    user_id: string | null;
    text: string;
    thread_ts: string | null;
    subtype: string | null;
    reply_count: number;
    reactions_json: string | null;
    files_json: string | null;
  }> {
    let sql =
      'SELECT ts, user_id, text, thread_ts, subtype, reply_count, reactions_json, files_json FROM messages WHERE channel_id = ?';
    const params: (string | number)[] = [channelId];

    if (since) {
      sql += ' AND ts >= ?';
      params.push(since);
    }
    if (until) {
      sql += ' AND ts <= ?';
      params.push(until);
    }

    sql += ' ORDER BY ts ASC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as Array<{
      ts: string;
      user_id: string | null;
      text: string;
      thread_ts: string | null;
      subtype: string | null;
      reply_count: number;
      reactions_json: string | null;
      files_json: string | null;
    }>;
  }

  // --- Sync cursor operations ---

  getSyncCursor(
    channelId: string,
  ): { oldest_ts: string | null; latest_ts: string | null; last_sync_at: string } | null {
    return (
      (this.db
        .prepare('SELECT oldest_ts, latest_ts, last_sync_at FROM sync_cursors WHERE channel_id = ?')
        .get(channelId) as {
        oldest_ts: string | null;
        latest_ts: string | null;
        last_sync_at: string;
      } | undefined) || null
    );
  }

  updateSyncCursor(
    channelId: string,
    oldestTs: string | null,
    latestTs: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursors (channel_id, oldest_ts, latest_ts, last_sync_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           oldest_ts = CASE WHEN excluded.oldest_ts < sync_cursors.oldest_ts OR sync_cursors.oldest_ts IS NULL
                       THEN excluded.oldest_ts ELSE sync_cursors.oldest_ts END,
           latest_ts = CASE WHEN excluded.latest_ts > sync_cursors.latest_ts OR sync_cursors.latest_ts IS NULL
                       THEN excluded.latest_ts ELSE sync_cursors.latest_ts END,
           last_sync_at = excluded.last_sync_at`,
      )
      .run(channelId, oldestTs, latestTs, new Date().toISOString());
  }

  // --- Search operations ---

  searchMessages(
    query: string,
    channelId?: string,
    userId?: string,
    since?: string,
    limit = 50,
  ): Array<{
    channel_id: string;
    ts: string;
    user_id: string | null;
    text: string;
    thread_ts: string | null;
    channel_name?: string;
    user_name?: string;
  }> {
    let sql = `
      SELECT m.channel_id, m.ts, m.user_id, m.text, m.thread_ts,
             c.name as channel_name, u.real_name as user_name
      FROM messages m
      LEFT JOIN channels c ON m.channel_id = c.id
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.text LIKE ?`;
    const params: (string | number)[] = [`%${query}%`];

    if (channelId) {
      sql += ' AND m.channel_id = ?';
      params.push(channelId);
    }
    if (userId) {
      sql += ' AND m.user_id = ?';
      params.push(userId);
    }
    if (since) {
      sql += ' AND m.ts >= ?';
      params.push(since);
    }

    sql += ' ORDER BY m.ts DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as Array<{
      channel_id: string;
      ts: string;
      user_id: string | null;
      text: string;
      thread_ts: string | null;
      channel_name?: string;
      user_name?: string;
    }>;
  }

  getUserTimeline(
    userId: string,
    since?: string,
    limit = 50,
  ): Array<{
    channel_id: string;
    ts: string;
    text: string;
    thread_ts: string | null;
    channel_name?: string;
  }> {
    let sql = `
      SELECT m.channel_id, m.ts, m.text, m.thread_ts,
             c.name as channel_name
      FROM messages m
      LEFT JOIN channels c ON m.channel_id = c.id
      WHERE m.user_id = ?`;
    const params: (string | number)[] = [userId];

    if (since) {
      sql += ' AND m.ts >= ?';
      params.push(since);
    }

    sql += ' ORDER BY m.ts DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params) as Array<{
      channel_id: string;
      ts: string;
      text: string;
      thread_ts: string | null;
      channel_name?: string;
    }>;
  }

  close(): void {
    this.db.close();
  }
}
