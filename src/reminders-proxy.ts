/**
 * Reminders Proxy — exposes the host's `remindctl` CLI to container agents via HTTP.
 *
 * Containers can't access macOS EventKit, so remindctl runs on the host and
 * this proxy accepts JSON requests and returns remindctl CLI output.
 *
 * POST /exec  { "args": ["add", "--title", "Call John", "--due", "tomorrow"] }
 * → { "status": "ok", "output": "..." } or { "status": "error", "error": "..." }
 */
import { createServer, Server } from 'http';
import { execFile } from 'child_process';
import { logger } from './logger.js';

const REMINDCTL_BIN =
  process.env.REMINDCTL_BIN || '/opt/homebrew/bin/remindctl';

// Allowed remindctl subcommands (prevent arbitrary execution)
const ALLOWED_COMMANDS = new Set([
  'add',
  'list',
  'complete',
  'delete',
  'today',
  'tomorrow',
  'week',
  'overdue',
  'all',
  'status',
  'authorize',
]);

export function startRemindersProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/exec') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let args: string[];
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          args = body.args;
          if (!Array.isArray(args) || args.length === 0) {
            throw new Error('args must be a non-empty array');
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              error: `Bad request: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
          return;
        }

        // Validate the subcommand
        const cmd = args[0];
        if (!ALLOWED_COMMANDS.has(cmd)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'error',
              error: `Command "${cmd}" not allowed. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`,
            }),
          );
          return;
        }

        execFile(
          REMINDCTL_BIN,
          args,
          {
            timeout: 15_000,
            maxBuffer: 1 * 1024 * 1024,
          },
          (err, stdout, stderr) => {
            if (err) {
              logger.debug(
                { args, stderr, code: err.code },
                'remindctl command failed',
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  status: 'error',
                  error: stderr || err.message,
                  output: stdout,
                }),
              );
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', output: stdout }));
          },
        );
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Reminders proxy started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
