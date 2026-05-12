# Vault retrieval

The Obsidian vault is mounted at `/workspace/extra/obsidian-vault/` (read-write).
Structure: `Areas/{CleanerDNS, AppEsteem, AppThrive, Personal}/{Companies, Contacts, Deals, Emails, Meetings, Slack, WhatsApp, Telegram, Signal}/`

## Three tools, by question shape

Pick by what the user is asking. Use the cheapest tool that fits.

1. **`mcp__vault__vault_search`** — hybrid semantic + lexical search (sqlite-vec + FTS5 BM25 with reciprocal rank fusion).
   - Best for: prose / paraphrase queries.
   - Examples: *"what did we discuss about pricing"*, *"last time threat detection came up"*, *"find anywhere <person> mentioned <topic>"*.
   - Returns one ranked excerpt per file with absolute paths. Read the full file when an excerpt looks relevant.

2. **`brain_query.py`** — structured entity lookup.
   - Best for: entity-named questions, staleness, relationship traversal.
   - Examples: *"status with Acme"*, *"who's been silent 90+ days"*, *"all meetings with X"*.
   - Run via: `python3 /workspace/extra/obsidian-vault/.brain/brain_query.py <subcommand>`
   - Subcommands: `lookup <slug>`, `search <query>`, `stale --days N`, `stats`, `related <slug>`, `timeline <slug>`.

3. **`grep`** — last resort. Use only when you already know the exact phrase.

## Routing rules

- Conceptual / paraphrase question → `vault_search` before grep.
- Question names a specific entity → `brain_query` before `vault_search`.
- Status / overview questions → fine to summarize from search snippets.
- Specifics of what someone said, tone of a conversation, exact terms/conditions discussed → **always load the full transcript or email body**, don't rely on the summary alone.
