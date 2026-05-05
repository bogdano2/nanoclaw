# MemU port spec — v1.2.43 → v2

**Goal:** preserve MemU functionality (semantic memory + auto-promotion to per-group CLAUDE.md) when migrating this fork from v1.2.43 to v2.0.x.

**TL;DR:** the host-side proxy survives untouched. The container-side bridge needs three changes: declare the MCP server in `container.json` instead of stdio-injected at spawn, read `agentGroupId` from `container.json` instead of an env var, and switch the auto-promotion target from `groups/<g>/CLAUDE.md` to `groups/<g>/CLAUDE.local.md`. There is no v2 equivalent of v1's session-start `/context` injection — the agent must call MemU as a tool mid-conversation, not get memories pre-injected. That last item is the only real design change; the rest is rewiring.

---

## What MemU is, today (the surface area to port)

| File | Role | Migration outcome |
|---|---|---|
| `src/memu-proxy.ts` | Host HTTP server on :3003, Ollama embeddings, SQLite at `data/memu.db`, auto-promotion writer | **Keep as-is.** Runs as a host daemon either way. |
| `container/agent-runner/src/memu-mcp-stdio.ts` | Container-side stdio MCP bridge to the proxy | **Rewire registration.** v2 declares MCP servers in `container.json`, not via spawn-time stdio injection. |
| `src/index.ts` (host) | `startMemuProxy()` boot call | **Move out.** v2's `src/index.ts` no longer boots ad-hoc proxies. Run MemU as an external process or wrap as a v2 module/skill. |
| `src/container-runner.ts` (host) | Injects `MEMU_PROXY_PORT/HOST` env vars + `groupFolder` | **Replace with per-group `container.json` config.** |
| `container/agent-runner/src/index.ts` ~`L695-720` | Pre-message `/context` POST + remembered-context injection | **Delete this hook.** No v2 equivalent. Agent calls MemU as an MCP tool instead. |
| `data/memu.db` | SQLite memories + chunks + embeddings | **Copy as-is.** Schema is independent of v1/v2. |

---

## Per-file porting plan

### 1. `src/memu-proxy.ts` — host daemon

Runs on the host either way. No code change required, but its lifecycle moves:

- **v1**: started inline by `src/index.ts` as part of NanoClaw process startup.
- **v2**: must run independently. Two reasonable options:
  - (a) Standalone launchd plist (`com.nanoclaw.memu-proxy.plist`) — same pattern as `com.nanoclaw.rotate-logs.plist`. Simplest. **Recommended.**
  - (b) Wrap as a v2 "module skill" so it boots through v2's orchestration. Cleaner integration but more work and tied to v2 internals.

Pick (a) on migration day, switch to (b) later if needed.

### 2. `container/agent-runner/src/memu-mcp-stdio.ts` — MCP bridge

Code stays the same. Registration changes:

- **v1**: `container-runner.ts` injects env (`MEMU_PROXY_PORT`, `MEMU_PROXY_HOST`) and the agent-runner `index.ts` spawns the bridge as part of session startup.
- **v2** (per agent research, **verify on migration day**): MCP servers are declared in per-group `container.json` under an `mcpServers` map, e.g.:
  ```json
  {
    "mcpServers": {
      "memu": {
        "command": "bun",
        "args": ["run", "/app/agent-runner/memu-mcp-stdio.ts"],
        "env": {
          "MEMU_PROXY_HOST": "host.docker.internal",
          "MEMU_PROXY_PORT": "3003"
        },
        "instructions": "MemU semantic memory tool. Call /memorize to save..."
      }
    }
  }
  ```
- The bridge runs under **Bun** in v2's container, not Node. Verify our stdio bridge's `node:`-prefixed imports and `Buffer` usage work under Bun. Most likely zero changes; budget 30 min to test.

### 3. Group identity: `groupFolder` → `agentGroupId`

- **v1**: container gets `GROUP_FOLDER=main` env var; MemU uses it as `groupFolder` for DB partitioning.
- **v2** (per research, **verify**): container reads `agentGroupId` from `container.json`. The bridge needs to surface this to the proxy.
- Migration: in `memu-mcp-stdio.ts`, replace `process.env.GROUP_FOLDER` with the equivalent from container.json (whatever shape v2 uses). Keep the `groupFolder` field name in MemU's DB and HTTP API — don't migrate `data/memu.db`. The bridge maps v2's `agentGroupId` → existing `groupFolder` value.

### 4. Auto-promotion target: `CLAUDE.md` → `CLAUDE.local.md`

- **v1**: `promoteMemory()` in `memu-proxy.ts` writes the "Learned Behaviors" section into `groups/<folder>/CLAUDE.md`.
- **v2**: per-group `CLAUDE.md` is composed at every spawn from a shared base + skill fragments. The human-editable per-group file is now `CLAUDE.local.md`. Writing to `CLAUDE.md` would be overwritten on every container spawn.
- One-line change: in `promoteMemory()`, change the path from `CLAUDE.md` to `CLAUDE.local.md`.
- The v2 `migrate-from-v1` skill apparently auto-converts existing per-group `CLAUDE.md` → `CLAUDE.local.md`. Confirm the existing Learned Behaviors section comes through.

### 5. Session-start `/context` injection — **DELETE**

This is the hook in `container/agent-runner/src/index.ts:695-720` that POSTs to `/context` before the first message and prepends a `<remembered-context>` block to the prompt. **It has no v2 equivalent and should not be ported.**

The reason: v2's two-DB session split + composed CLAUDE.md model means session-start hooks aren't a thing in the same way. Memories should be discovered via MCP tool calls during the conversation, not pre-injected.

Loss: the agent no longer gets remembered behaviors automatically loaded at session start. To compensate, do one of:
- (a) Document explicitly in `groups/main/CLAUDE.local.md` that the agent should call `memu.search` / `memu.list_behaviors` early in any session involving the relevant entities. **Cheapest, recommended for first cut.**
- (b) Add an MCP tool `memu.get_session_context` and document in CLAUDE.local.md that the agent should call it first thing. **More structured but no enforcement; agent may still skip it.**
- (c) Re-implement injection by hijacking v2's first-message processing somewhere host-side. **Don't do this on migration day; come back to it if (a)/(b) prove inadequate.**

The auto-promotion mechanism itself still works fine — the agent stores via `memu.memorize`, the host-side proxy reinforces and promotes to `CLAUDE.local.md` after the threshold.

---

## Migration-day sequence

Assumes you've followed the upstream-recommended path: fresh v2 checkout at `/Users/Shared/nanoclaw-v2/`, `bash migrate-v2.sh` ran, `/migrate-from-v1` skill ran. v1 install at `/Users/Shared/nanoclaw/` is still hot.

1. **Pre-flight (10 min)** — read `docs/v1-to-v2-changes.md`, `docs/db-session.md`, `docs/architecture.md` from v2. Confirm or correct any of the v2-specific claims in this spec (marked "verify").

2. **Copy host proxy (5 min)** — copy `src/memu-proxy.ts`, `src/group-folder.ts` (if used), and `data/memu.db` from v1 to v2. Don't run it yet.

3. **Wire the host daemon (15 min)** — write `~/Library/LaunchAgents/com.nanoclaw.memu-proxy.plist` that runs the proxy standalone. Test by curling `http://localhost:3003/stats` with `{"groupFolder":"main"}`.

4. **Wire the container bridge (30 min)** — copy `memu-mcp-stdio.ts` into v2's agent-runner source tree. Add to `groups/main/container.json` (or v2 equivalent) the `mcpServers.memu` entry. Update `groupFolder` resolution. Rebuild container.

5. **Switch promotion target (5 min)** — change the path in `promoteMemory()` from `CLAUDE.md` to `CLAUDE.local.md`.

6. **Delete session-start injection (5 min)** — remove the `/context` block in v2's agent-runner `index.ts` (don't port it).

7. **Smoke test (15 min)** — send a message that should trigger MemU activity. Verify proxy logs show `/memorize` or `/retrieve` calls. Verify a 3x-reinforced behavior gets promoted into `CLAUDE.local.md`.

8. **Document (5 min)** — update `groups/main/CLAUDE.local.md` to explicitly tell the agent to call `memu.search` early in BD-relevant sessions (since auto-injection is gone).

Total: ~90 minutes if v2 docs match the agent's research; budget 3 hours to handle drift and the inevitable "wait, what does this field do" moments.

---

## Verification checklist

- [ ] `curl localhost:3003/stats` returns JSON
- [ ] Container starts without "MemU not available" warnings
- [ ] Agent can call `memu.memorize` (test by asking it to remember something)
- [ ] After 3 reinforcements, the entry appears in `groups/main/CLAUDE.local.md`
- [ ] No bullet recursion (entries appear with single `-` prefix, not `- -` or `- - -`) — confirms the bug fixes survive the port
- [ ] `data/memu.db` row count matches v1 (`SELECT COUNT(*) FROM memories WHERE group_folder = 'main'`)
- [ ] Agent can recall a known behavior when asked (proves search/retrieve still work)

---

## Open questions / risks (resolve on migration day)

1. **Bun compatibility for the stdio bridge.** Likely fine but unverified. If it breaks, fallback: spawn the bridge under Node via `node` instead of `bun` in `mcpServers.memu.command`.
2. **`agentGroupId` shape.** Is it a UUID, a slug like "main", or both? Determines the mapping logic in `memu-mcp-stdio.ts`.
3. **`container.json` schema.** Agent's research says it has `mcpServers`, `agentGroupId`, `additionalMounts`. Confirm exact field names and where the file lives (per-group vs per-session).
4. **Composed `CLAUDE.md` regeneration timing.** The agent claims `CLAUDE.md` is regenerated on every container spawn. If true, anything we accidentally write there is lost — only `CLAUDE.local.md` is durable. Verify before any tooling writes to either.
5. **Loss of session-start injection — is the agent OK without it?** The cheap mitigation (CLAUDE.local.md instructions) relies on the agent reading and following them. If "Andy" forgets to consult MemU at session start in BD scenarios, escalate to option (b) or (c) from §5.
6. **v2 `migrate-from-v1` skill behavior on custom proxies.** Per research, it stashes custom source to `docs/v1-fork-reference/` rather than porting. Don't expect it to wire MemU for you — this spec's job.

---

## What to do *before* migration day

- Let the v1 MemU bullet-recursion fix bake for ~1 week. If "Andy" runs cleanly with no new bullet bloat in `groups/main/CLAUDE.md`, the fix is confirmed and we can migrate without dragging unresolved bugs into v2.
- Spot-check `data/memu.db` weekly to confirm `reinforcement_count` is stable (not climbing rapidly on the same logical content — that would mean the dedup / strip is missing a case).
- Read `docs/v1-to-v2-changes.md` from `upstream/main` once before migration day. Cross-check this spec against it; update whichever is wrong.
