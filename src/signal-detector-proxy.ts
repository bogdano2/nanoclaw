/**
 * Signal-detector HTTP proxy — exposes runSignalDetector() to other
 * processes (bd-brain-sync's Python sync_plaud.py, sync_gmail.py, etc.).
 *
 * One source of truth for the two-pass Haiku+Opus detector logic; callers
 * just POST a normalized envelope.
 *
 * POST /detect
 *   Body: {
 *     channel: "plaud" | "gmail" | "telegram" | "slack" | "signal" | "manual",
 *     source: "<phone or email or 'bogdan'>",
 *     text: "<message body or transcript summary>",
 *     noteToSelf: bool,
 *     envelopeTimestamp: number | null,
 *     ownerPhone: "<the registered account phone — used for the structural
 *                  filter; pass +15129217183 to escalate to Opus>"
 *   }
 *   Response: 202 Accepted with { status: "queued" } — runSignalDetector
 *   runs async and appends to the candidates JSONL. Caller is not awaited.
 *
 * Why 202: signal-detector is fire-and-forget by design (gbrain SKILL.md:
 * "never block the main response"). Callers shouldn't wait on Opus.
 */
import { createServer, Server } from 'http';

import { logger } from './logger.js';
import { runSignalDetector, DetectorInput } from './signal-detector.js';

interface DetectRequestBody {
  channel?: string;
  source?: string;
  text?: string;
  noteToSelf?: boolean;
  envelopeTimestamp?: number | null;
  ownerPhone?: string;
}

function isValidInput(body: DetectRequestBody): body is Required<DetectRequestBody> {
  return (
    typeof body.channel === 'string' &&
    typeof body.source === 'string' &&
    typeof body.text === 'string' &&
    body.text.length > 0 &&
    typeof body.ownerPhone === 'string'
  );
}

export function startSignalDetectorProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/detect') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: DetectRequestBody;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'Invalid JSON' }));
          return;
        }

        if (!isValidInput(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              error: 'Missing or invalid fields. Required: channel (string), source (string), text (non-empty string), ownerPhone (string).',
            }),
          );
          return;
        }

        const input: DetectorInput = {
          channel: body.channel,
          source: body.source,
          text: body.text,
          noteToSelf: !!body.noteToSelf,
          envelopeTimestamp:
            typeof body.envelopeTimestamp === 'number'
              ? body.envelopeTimestamp
              : undefined,
          ownerPhone: body.ownerPhone,
        };

        // Fire-and-forget. Detector logs its own success/failure.
        void runSignalDetector(input).catch((err) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'signal-detector-proxy unexpected throw from runSignalDetector',
          );
        });

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'queued', channel: input.channel }));
      });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      logger.info({ port, host }, 'Signal-detector proxy started');
      resolve(server);
    });
  });
}
