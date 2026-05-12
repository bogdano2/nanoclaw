/**
 * Signal channel via signal-cli (https://github.com/AsamK/signal-cli).
 *
 * Replaces the WhatsApp/Baileys channel. Privacy posture is better (Signal
 * is E2E with no metadata harvesting), stability is better (signal-cli is
 * officially-blessed-ish; protocol churn is far less aggressive than Baileys'
 * reverse-engineered WhatsApp protocol).
 *
 * Architecture:
 *   - Spawn `signal-cli daemon --socket <path>` as a long-running subprocess.
 *     Single process handles both directions; avoids account-file lock
 *     contention that would occur with concurrent `signal-cli send` /
 *     `signal-cli receive` invocations.
 *   - Connect to that socket and speak JSON-RPC 2.0 over it.
 *   - Inbound: daemon emits `receive` notifications (one per incoming
 *     envelope). Filter for Note-to-Self messages prefixed with the trigger
 *     phrase, strip the prefix, hand to NanoClaw's onMessage callback.
 *   - Outbound: JSON-RPC `send` method. Note-to-Self uses `noteToSelf: true`.
 *
 * Group identity:
 *   - Andy's main group is identified by jid `signal:<phone>` where phone
 *     is the registered signal-cli account. The channel `ownsJid` returns
 *     true for any jid starting with `signal:`.
 *
 * Daemon supervision:
 *   - On daemon exit, schedule a reconnect after 5s (exponential backoff up
 *     to 60s). Keeps the channel resilient to signal-cli crashes / restarts.
 *   - On `disconnect()`, SIGTERM the daemon and wait briefly before SIGKILL.
 */
import { spawn, ChildProcess } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import net from 'net';

import { Channel, NewMessage } from '../types.js';
import { logger as baseLogger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';

const SIGNAL_CLI = process.env.SIGNAL_CLI_BIN || '/opt/homebrew/bin/signal-cli';
const ACCOUNT = process.env.SIGNAL_ACCOUNT || '+15129217183';
const SOCKET_PATH = process.env.SIGNAL_SOCKET || '/tmp/nanoclaw-signal.sock';
const TRIGGER_RE = /^@andy\b/i;
const SIGNAL_MAX_CHARS = 3500; // Signal client limit is ~4000; leave headroom

const logger = baseLogger;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: { message?: string; timestamp?: number };
  syncMessage?: {
    sentMessage?: {
      message?: string;
      destination?: string;
      destinationNumber?: string;
      destinationUuid?: string;
      timestamp?: number;
    };
  };
}

interface ReceiveParams {
  envelope?: SignalEnvelope;
  account?: string;
}

class SignalChannel implements Channel {
  name = 'signal';
  private daemon: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private rpcId = 1;
  private pendingRpc = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private rxBuffer = '';
  private connected = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartDelayMs = 5000;
  private intentionallyClosed = false;

  constructor(private opts: ChannelOpts) {}

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    await this.spawnDaemonAndConnect();
  }

  private async spawnDaemonAndConnect(): Promise<void> {
    // Remove any leftover socket from a prior crashed daemon.
    if (existsSync(SOCKET_PATH)) {
      try {
        unlinkSync(SOCKET_PATH);
      } catch (err) {
        logger.warn({ err }, 'failed to remove stale signal socket');
      }
    }

    logger.info({ account: ACCOUNT, socket: SOCKET_PATH }, 'starting signal-cli daemon');
    this.daemon = spawn(
      SIGNAL_CLI,
      [
        '-a',
        ACCOUNT,
        'daemon',
        '--socket',
        SOCKET_PATH,
        '--receive-mode',
        'on-start',
        '--no-receive-stdout',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.daemon.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.debug({ line }, 'signal-cli stderr');
    });

    this.daemon.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'signal-cli daemon exited');
      this.connected = false;
      this.daemon = null;
      if (!this.intentionallyClosed) this.scheduleRestart();
    });

    await this.waitForSocket(SOCKET_PATH, 30_000);

    this.socket = net.createConnection(SOCKET_PATH);
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.onSocketData(chunk));
    this.socket.on('error', (err) => {
      logger.warn({ err: err.message }, 'signal socket error');
    });
    this.socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      if (!this.intentionallyClosed) this.scheduleRestart();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signal socket connect timeout')), 5000);
      this.socket!.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.connected = true;
    this.restartDelayMs = 5000; // reset backoff on successful connect
    logger.info('signal channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) throw new Error('Signal channel not connected');
    const recipient = jidToRecipient(jid);
    const isNoteToSelf = recipient === ACCOUNT;

    for (const chunk of chunkMessage(text, SIGNAL_MAX_CHARS)) {
      const params: Record<string, unknown> = { message: chunk };
      if (isNoteToSelf) {
        params.noteToSelf = true;
      } else {
        params.recipient = [recipient];
      }
      await this.rpc('send', params);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // Reject pending RPCs so callers don't hang forever.
    for (const [, p] of this.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(new Error('Signal channel disconnecting'));
    }
    this.pendingRpc.clear();

    this.socket?.end();
    this.socket = null;

    if (this.daemon && !this.daemon.killed) {
      this.daemon.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      if (this.daemon && !this.daemon.killed) {
        this.daemon.kill('SIGKILL');
      }
    }
    this.daemon = null;
    this.connected = false;
  }

  private async waitForSocket(path: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(path)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`signal-cli socket did not appear at ${path} within ${timeoutMs}ms`);
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60_000);
    logger.info({ delayMs: delay }, 'scheduling signal channel reconnect');
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.spawnDaemonAndConnect();
      } catch (err) {
        logger.error({ err }, 'signal channel reconnect failed; retrying');
        this.scheduleRestart();
      }
    }, delay);
  }

  private onSocketData(chunk: string): void {
    this.rxBuffer += chunk;
    let nl: number;
    while ((nl = this.rxBuffer.indexOf('\n')) !== -1) {
      const line = this.rxBuffer.slice(0, nl).trim();
      this.rxBuffer = this.rxBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.handleRpcMessage(msg);
      } catch (err) {
        logger.warn({ err, line: line.slice(0, 200) }, 'malformed JSON from signal-cli');
      }
    }
  }

  private handleRpcMessage(msg: Record<string, unknown>): void {
    if (
      typeof msg.id === 'number' &&
      ('result' in msg || 'error' in msg)
    ) {
      const handler = this.pendingRpc.get(msg.id);
      if (handler) {
        clearTimeout(handler.timer);
        this.pendingRpc.delete(msg.id);
        const r = msg as unknown as JsonRpcResponse;
        if (r.error) handler.reject(new Error(`${r.error.code}: ${r.error.message}`));
        else handler.resolve(r.result);
      }
    } else if (msg.method === 'receive' && msg.params) {
      this.handleInbound(msg.params as ReceiveParams);
    }
  }

  private handleInbound(params: ReceiveParams): void {
    const env = params.envelope;
    if (!env) return;

    const source = env.sourceNumber || env.source;
    let text: string | undefined;
    let destination: string | undefined;
    let timestamp: number | undefined;

    if (env.dataMessage?.message) {
      text = env.dataMessage.message;
      timestamp = env.dataMessage.timestamp || env.timestamp;
      // dataMessage is a message TO us from `source`. Not Note-to-Self.
      destination = ACCOUNT;
    } else if (env.syncMessage?.sentMessage?.message) {
      // syncMessage: this device's primary sent something; we're receiving the sync copy.
      const sent = env.syncMessage.sentMessage;
      text = sent.message;
      timestamp = sent.timestamp || env.timestamp;
      destination = sent.destinationNumber || sent.destination;
    }

    if (!text) return;

    // Trigger filter: only "@andy" prefix.
    if (!TRIGGER_RE.test(text.trim())) return;

    // Note-to-Self gate: source == destination, both == ACCOUNT.
    const isNoteToSelf =
      !!env.syncMessage?.sentMessage &&
      destination === ACCOUNT &&
      source === ACCOUNT;

    if (!isNoteToSelf) {
      logger.info(
        { source, destination, textPreview: text.slice(0, 60) },
        'signal trigger received outside Note-to-Self — ignoring',
      );
      return;
    }

    const jid = `signal:${ACCOUNT}`;
    const tsIso = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
    const messageId = `sig-${timestamp ?? Date.now()}`;
    const stripped = text.replace(/^@andy\s*/i, '').trim();

    const message: NewMessage = {
      id: messageId,
      chat_jid: jid,
      sender: source || ACCOUNT,
      sender_name: 'self',
      content: stripped || text,
      timestamp: tsIso,
      is_from_me: true,
      is_bot_message: false,
    };

    logger.info(
      { messageId, contentPreview: message.content.slice(0, 80) },
      'signal inbound trigger',
    );
    this.opts.onChatMetadata(jid, tsIso, 'Andy', 'signal', false);
    this.opts.onMessage(jid, message);
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('signal socket not connected'));
        return;
      }
      const id = this.rpcId++;
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`signal-cli RPC timeout: ${method}`));
      }, 30_000);
      this.pendingRpc.set(id, { resolve, reject, timer });
      const req = { jsonrpc: '2.0', id, method, params };
      this.socket.write(JSON.stringify(req) + '\n');
    });
  }
}

function jidToRecipient(jid: string): string {
  return jid.replace(/^signal:/, '');
}

/**
 * Split text on newlines so each chunk fits within `max`. Prefers paragraph
 * boundaries; falls back to hard-cutting only when no whitespace is available.
 */
function chunkMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const window = text.slice(i, end);
      const lastNl = window.lastIndexOf('\n');
      if (lastNl > Math.floor(max * 0.7)) {
        end = i + lastNl + 1;
      } else {
        const lastSpace = window.lastIndexOf(' ');
        if (lastSpace > Math.floor(max * 0.7)) end = i + lastSpace + 1;
      }
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

registerChannel('signal', (opts: ChannelOpts) => new SignalChannel(opts));
