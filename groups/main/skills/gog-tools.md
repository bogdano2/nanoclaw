# Gmail, Calendar, Drive

Use the MCP tools (`mcp__gog__*`) — **never** run `gog` directly via bash.

## Account routing

| Account | Use for |
|---------|---------|
| `bogdan@cleanerdns.com` | CleanerDNS / Quad9 (primary work) |
| `bogdan@appthrive.ai` | AppEsteem / AppThrive (second work) |
| `bogdan.odulinski@technocampus.com` | Personal |

**Check all relevant accounts** — don't assume which account a topic belongs to. If you're searching for messages about a specific company, query all three and merge.

## Drive operations

For Drive operations not covered by a dedicated MCP tool, use `mcp__gog__gog_command` with structured args:

```
["drive", "ls", "--account=bogdan@cleanerdns.com", "--json"]
```

The `--json` flag is required for parseable output.

## Calendar events

When creating calendar events on Bogdan's behalf — **don't**. Per BD Mindset rule: "For meetings, suggest dates/times rather than creating events." Brain drafts the meeting proposal; Bogdan creates the event himself.

If asked to look up calendar context (attendees, free time, existing conflicts), that's fine — read-only.
