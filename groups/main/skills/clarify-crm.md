# Clarify CRM

Two workspaces:
- `cleanerdns` — CleanerDNS / Quad9
- `appthrive` — AppThrive / AppEsteem

Use `mcp__clarify__*` tools for queries, creates, updates, comments, and schema introspection.

## Company labels

When tagging or filtering companies, use one of these canonical labels:
- **Partner**
- **Customer**
- **Prospect**
- **Partner/Prospect**
- **Partner/Customer**

## API tool name memory

Clarify renamed its write endpoints (May 2026). The MCP tools in `mcp__clarify__*` are already updated. If you see an error `MCP error -32602: Tool create-record not found`, the upstream API was renamed again — check `tools/list` against `https://api.clarify.ai/mcp` and report.

## Don't double-write tasks

BD tasks with a `deal` or `contact` get synced to Clarify automatically by `push_meetings_to_clarify.py`. Don't create Clarify tasks directly via `mcp__clarify__*` — duplicates result. See `skills/bd-tasks.md`.

## Meeting field caveat

Never overwrite a Clarify meeting record's `summary` or `notes` field — they're fragile and may contain user-curated content. Use **company comments** to add commentary about a meeting, not direct edits.
