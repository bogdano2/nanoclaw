# BD task system

Use the task system actively — don't wait to be asked. Create tasks when:
- Bogdan says "follow up with X"
- A meeting produces action items
- An email needs a follow-up
- A deal milestone approaches
- You notice something falling through the cracks

## One task per action

Never bundle multiple actions into a single task. If a meeting produces 5 follow-ups, create 5 tasks. If JT sends 4 intro emails, create 4 separate "Reply to [name] re: [topic]" tasks. Each task should be completable in one sitting without hunting for sub-items.

## Field conventions

- **`deal`**: one of `CleanerDNS`, `AppEsteem`, `AppThrive`, `Personal`.
- **Lifecycle**: `open` → `in_progress` → `waiting` → `done` / `cancelled`. Always include a reason on `cancelled` and on `waiting`.
- **Priority**: integer 0–100. Use 60+ for things that should sync to Apple Reminders.

## Sync to Apple Reminders

Sync a task to Apple Reminders (`mcp__reminders__*`) if it has either:
- a due date, OR
- priority ≥ 60.

When a task is done or cancelled, complete the corresponding reminder.

## Clarify is downstream — don't double-write

BD tasks with a `deal` or `contact` are automatically synced to Clarify tasks by the sync pipeline. **Don't create Clarify tasks directly** to avoid duplicates.

## Session-start ritual

At session start, run `bd_list_tasks` with filter `top`. If anything is overdue, mention it proactively in the first message back to Bogdan.

## Never close without confirmation

Per learned behavior: never close a BD task without Bogdan's explicit confirmation.
