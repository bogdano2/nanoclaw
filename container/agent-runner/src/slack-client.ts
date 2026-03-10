/**
 * Slack Web API client using session tokens (xoxc + d cookie).
 * Rate-limited, with auto-retry on 429 and exponential backoff.
 */

import type {
  ConversationsListResponse,
  ConversationsHistoryResponse,
  ConversationsRepliesResponse,
  UsersListResponse,
  UsersInfoResponse,
  SlackChannel,
  SlackUser,
  SlackMessage,
} from './slack-types.js';

const SLACK_API_BASE = 'https://slack.com/api';

// Sliding window: 45 requests per 60 seconds (conservative vs 50 limit)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 45;
const MAX_RETRIES = 3;

function log(msg: string): void {
  console.error(`[slack-client] ${msg}`);
}

export class SlackClient {
  private token: string;
  private cookie: string;
  private requestTimestamps: number[] = [];

  constructor(token: string, cookie: string) {
    this.token = token;
    this.cookie = cookie;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    // Remove timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );

    if (this.requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
      const oldest = this.requestTimestamps[0];
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 100;
      log(`Rate limit: waiting ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    this.requestTimestamps.push(Date.now());
  }

  async request<T>(
    method: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.rateLimit();

      try {
        const body = new URLSearchParams(params);
        const res = await fetch(`${SLACK_API_BASE}/${method}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Cookie: `d=${this.cookie}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10);
          log(`429 rate limited, retrying after ${retryAfter}s (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = (await res.json()) as T & { ok: boolean; error?: string };

        if (!data.ok) {
          const err = data.error || 'unknown_error';
          if (err === 'invalid_auth' || err === 'token_revoked' || err === 'not_authed') {
            throw new Error(
              `Slack auth error: ${err}. Re-extract xoxc token and d cookie from Slack desktop app.`,
            );
          }
          throw new Error(`Slack API error: ${err}`);
        }

        return data;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry auth errors
        if (lastError.message.includes('auth error')) throw lastError;

        if (attempt < MAX_RETRIES) {
          const backoff = Math.pow(2, attempt) * 1000;
          log(`Request failed (attempt ${attempt + 1}): ${lastError.message}, retrying in ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Paginate through a cursor-based Slack API endpoint.
   */
  private async paginate<T, R>(
    method: string,
    params: Record<string, string>,
    extractItems: (response: R) => T[],
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;

    do {
      const reqParams = { ...params };
      if (cursor) reqParams.cursor = cursor;

      const response = await this.request<R>(method, reqParams);
      items.push(...extractItems(response));

      const meta = (response as { response_metadata?: { next_cursor?: string } })
        .response_metadata;
      cursor = meta?.next_cursor || undefined;
    } while (cursor);

    return items;
  }

  async listConversations(
    types = 'public_channel,private_channel,mpim,im',
  ): Promise<SlackChannel[]> {
    return this.paginate<SlackChannel, ConversationsListResponse>(
      'conversations.list',
      { types, limit: '200', exclude_archived: 'false' },
      (r) => r.channels,
    );
  }

  async conversationHistory(
    channelId: string,
    oldest?: string,
    latest?: string,
    limit = 200,
  ): Promise<{ messages: SlackMessage[]; hasMore: boolean }> {
    const params: Record<string, string> = {
      channel: channelId,
      limit: String(limit),
    };
    if (oldest) params.oldest = oldest;
    if (latest) params.latest = latest;

    const res = await this.request<ConversationsHistoryResponse>(
      'conversations.history',
      params,
    );

    return { messages: res.messages || [], hasMore: res.has_more || false };
  }

  /**
   * Fetch all messages in a channel within a time range, handling pagination.
   */
  async conversationHistoryAll(
    channelId: string,
    oldest?: string,
    latest?: string,
  ): Promise<SlackMessage[]> {
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;

    // conversations.history paginates backwards (newest first),
    // using 'latest' as the cursor for the next page
    let currentLatest = latest;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params: Record<string, string> = {
        channel: channelId,
        limit: '200',
      };
      if (oldest) params.oldest = oldest;
      if (currentLatest) params.latest = currentLatest;
      if (cursor) params.cursor = cursor;

      const res = await this.request<ConversationsHistoryResponse>(
        'conversations.history',
        params,
      );

      const messages = res.messages || [];
      allMessages.push(...messages);

      if (!res.has_more || messages.length === 0) break;

      // Use response_metadata cursor if available, otherwise use oldest message ts
      const meta = res.response_metadata;
      if (meta?.next_cursor) {
        cursor = meta.next_cursor;
      } else {
        // Fallback: use the ts of the last (oldest) message as the new latest
        currentLatest = messages[messages.length - 1].ts;
        cursor = undefined;
      }
    }

    return allMessages;
  }

  async conversationReplies(
    channelId: string,
    threadTs: string,
  ): Promise<SlackMessage[]> {
    return this.paginate<SlackMessage, ConversationsRepliesResponse>(
      'conversations.replies',
      { channel: channelId, ts: threadTs, limit: '200' },
      (r) => r.messages,
    );
  }

  async listUsers(): Promise<SlackUser[]> {
    return this.paginate<SlackUser, UsersListResponse>(
      'users.list',
      { limit: '200' },
      (r) => r.members,
    );
  }

  async userInfo(userId: string): Promise<SlackUser> {
    const res = await this.request<UsersInfoResponse>('users.info', {
      user: userId,
    });
    return res.user;
  }
}
