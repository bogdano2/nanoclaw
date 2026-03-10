/**
 * TypeScript interfaces for Slack Web API responses.
 * Used by the session-token-based client (xoxc + d cookie).
 */

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_archived: boolean;
  is_member: boolean;
  topic?: { value: string };
  purpose?: { value: string };
  num_members?: number;
  user?: string; // For DMs, the other user's ID
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    email?: string;
    real_name?: string;
  };
  is_bot?: boolean;
  deleted?: boolean;
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackFile {
  id: string;
  name: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
}

export interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  reactions?: SlackReaction[];
  files?: SlackFile[];
  bot_id?: string;
}

export interface SlackApiResponse<T = unknown> {
  ok: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
  [key: string]: T | boolean | string | undefined | { next_cursor?: string };
}

export interface ConversationsListResponse extends SlackApiResponse {
  channels: SlackChannel[];
}

export interface ConversationsHistoryResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
}

export interface ConversationsRepliesResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
}

export interface UsersListResponse extends SlackApiResponse {
  members: SlackUser[];
}

export interface UsersInfoResponse extends SlackApiResponse {
  user: SlackUser;
}
