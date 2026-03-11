---
name: update-deps
description: Update npm dependencies, Ollama models, and rebuild the agent container. Covers everything /update-nanoclaw and /update-skills don't.
---

# About

Updates all non-git dependencies: npm packages, Ollama embedding models, and the Docker container image. Complementary to `/update-nanoclaw` (core code) and `/update-skills` (skill branches).

Run `/update-deps` in Claude Code.

## What it updates

| Component | How | Risk |
|-----------|-----|------|
| npm packages (host) | `npm outdated` → `npm update` | Low — respects semver ranges in package.json |
| npm packages (container) | `npm outdated` inside agent-runner | Low — same |
| Ollama models | `ollama list` → `ollama pull <model>` | None — pull is non-destructive |
| Ollama itself | `brew upgrade ollama` | Low — backward compatible |
| Container image | `./container/build.sh` | Medium — rebuilds from scratch |

---

# Goal
Update all non-git dependencies safely, with preview before action, and rebuild/restart only if something changed.

# Operating principles
- Always show what's outdated BEFORE updating anything.
- Ask the user before proceeding with updates.
- Track whether anything actually changed to avoid unnecessary rebuilds.
- Never force-update past semver major versions without asking.
- Restart NanoClaw only if something changed.

# Step 0: Preflight

Check that required tools are available:
- `node --version` and `npm --version`
- `ollama --version` (if missing, skip Ollama steps — warn user)
- `docker --version` (if missing, skip container steps — warn user)
- `brew --version` (if missing, skip brew upgrade — warn user)

Set a flag `CHANGES_MADE=false` to track whether anything was updated.

# Step 1: Preview npm packages (host)

Run from the project root:
- `npm outdated --long 2>&1`

This shows current vs wanted vs latest for all packages.

Categorize the output:
- **Patch/minor updates** (safe): version bump within semver range
- **Major updates** (review needed): major version jump

If nothing is outdated, say so and move to Step 2.

If packages are outdated, show the list and use AskUserQuestion:
- Option A: "Update all (within semver ranges)" — runs `npm update`
- Option B: "Update all including major versions" — runs `npm install <pkg>@latest` for each
- Option C: "Skip npm updates"

If user picks A or B:
- Run the appropriate command.
- Run `npm run build` to verify nothing broke.
- If build fails, show the error and try to fix. If unfixable, revert with `git checkout -- package.json package-lock.json && npm install`.
- Set `CHANGES_MADE=true`.

# Step 2: Preview npm packages (container agent-runner)

Run from `container/agent-runner/`:
- `cd container/agent-runner && npm outdated --long 2>&1`

Same categorization and user prompt as Step 1.

If user chooses to update:
- Run `npm update` (or `npm install <pkg>@latest` for major).
- Run `npm run build` in the agent-runner directory to verify.
- Set `CHANGES_MADE=true`.
- Note: container rebuild needed (Step 5 will handle this).

# Step 3: Update Ollama

Check if Ollama is installed:
- `which ollama`

If not found, skip this step with a note.

If found:
- Show current Ollama version: `ollama --version`
- Check for brew upgrade: `brew outdated ollama 2>&1`
- If an upgrade is available, ask the user:
  - Option A: "Upgrade Ollama" — `brew upgrade ollama`
  - Option B: "Skip"
- If upgraded, restart the service: `brew services restart ollama`

Check installed models:
- `ollama list`

For each model, pull the latest version:
- `ollama pull <model-name>`
- Ollama pull is safe — it only downloads if a newer version exists.

No user prompt needed for model pulls (they're non-destructive).

# Step 4: Check container base image

Show the current base image from the Dockerfile:
- `grep '^FROM' container/Dockerfile`

Check if a newer digest is available:
- `docker pull <base-image> --dry-run 2>&1` (or just note the current image age)

This is informational — the actual rebuild happens in Step 5.

# Step 5: Rebuild container (if needed)

If `CHANGES_MADE=true` (from Steps 1-4):
- Tell the user what changed and that a container rebuild is recommended.
- Use AskUserQuestion:
  - Option A: "Rebuild container now" — `./container/build.sh`
  - Option B: "Skip rebuild (I'll do it later)"
- If user picks A:
  - Run `./container/build.sh`
  - If build fails, show the error. Do not attempt to fix Dockerfile issues automatically — ask the user.

If `CHANGES_MADE=false`:
- Tell the user everything is up to date, no rebuild needed.
- Still offer to rebuild if they want: "Force rebuild anyway? This pulls the latest base image."

# Step 6: Restart NanoClaw (if needed)

If `CHANGES_MADE=true` and container was rebuilt:
- Ask the user if they want to restart NanoClaw now.
- Use AskUserQuestion:
  - Option A: "Restart now"
  - Option B: "Skip — I'll restart later"
- If restart:
  - Detect platform:
    - macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
    - Linux: `systemctl --user restart nanoclaw`
    - Neither: `echo "Restart manually: npm run dev"`
  - Wait 3 seconds, then check logs for successful startup.

# Step 7: Summary

Show:
- npm packages updated (host): list or "none"
- npm packages updated (container): list or "none"
- Ollama version: current (upgraded from X if applicable)
- Ollama models pulled: list
- Container rebuilt: yes/no
- NanoClaw restarted: yes/no

If any updates were applied, remind the user:
- To test by sending a message to the agent
- That they can run `/update-deps` again anytime to check for new updates
