# Data sync

The bd-brain-sync pipeline pulls from external services into the vault every 3 hours via launchd. Manual triggers and status checks are below.

## Manual trigger

Drop a JSON file into `/workspace/extra/sync-triggers/` with the sync type:

```bash
echo '{"sync":"all"}' > /workspace/extra/sync-triggers/$(date +%s).json
```

Valid sync types:
- `gmail` — Gmail across all 3 accounts → `Areas/<Area>/Emails/`
- `plaud` — Plaud recordings (transcripts → vault, audio → Drive)
- `signal` — Signal DMs (reads nanoclaw's JSONL inbox, writes to `Areas/<Area>/Signal/`)
- `telegram` — Telegram DMs
- `slack` — Slack DMs
- `whatsapp` — WhatsApp (legacy; channel is disabled but sync still runs)
- `clarify` — Clarify CRM (companies, contacts, deals, meetings)
- `all` — everything in the wave-1 fanout

## Check status

```bash
cat /workspace/extra/sync-results/last_sync.json
```

Possible `status` values: `complete` (all green), `errors` (one or more failures).

When `status: errors`, the report includes `summary` (count by script) and `details` (truncated stderr). The alerter only emails Bogdan after two consecutive runs fail — single-run blips are suppressed (see `bd-brain-sync/scripts/run_all_syncs.sh:208`).

## Reading sync logs

Per-script logs live at `/workspace/extra/sync-logs/<name>.log` (read-only mount). Useful when diagnosing a sync error or finding the most recent successful run.
