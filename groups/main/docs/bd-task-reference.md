# BD Task System — Reference

## Priority Scoring

Priorities are computed dynamically (0-100):

- **Base priority** (0-100): Set when creating. 80+ = urgent, 60-79 = important, 40-59 = normal, <40 = low
- **Signal boost** (+0 to +25): Recent signals from contacts/deals bump related tasks. Decays over 14 days.
- **Deadline urgency** (+0 to +30): Exponential ramp as due date approaches. Maxes out when overdue.
- **Time decay** (-0 to -20): Tasks nobody touches gradually sink. Any signal or update resets this.

## Signal Weight Guide

- 10 = minor mention
- 30 = relevant update
- 50 = direct communication
- 80 = urgent/important
- 100 = critical

Signal types:
- `email_received` — Email arrives from a contact linked to a task
- `email_sent` — Bogdan sends an email about a task's deal
- `message_mention` — Someone mentions a deal/contact in chat
- `meeting` — A meeting covers a task's topic
- `manual_bump` — Bogdan says "bump this" or "this is urgent now" (use high weight 70-100)
- `deal_update` — Deal status changes (new info, stage change)

## Creating Tasks — Deadlines and Specificity

When creating tasks from meetings, emails, or chats:

1. **Look up real deadlines.** If a task mentions an event (RSA, CloudFest, board meeting, trial expiry), check the calendar for the actual date and set `due_date` *before* the event — not on or after it.
2. **Break into specific deliverables.** "Prepare materials" is not a task — "Draft NOH one-pager PDF", "Draft NOD product sheet", "Print 50 copies" are tasks.
3. **Match priority to timeline.** If something is due this week, it's 80+ priority. If the meeting notes say "before RSA" and RSA is in 3 days, that's priority 90+ with a due date of tomorrow.
4. **Don't genericize what the source spelled out.** If the meeting notes list specific action items with specific deliverables, create tasks that match.

## Apple Reminders Sync

After creating or updating a BD task, automatically sync it to Apple Reminders if it meets *any* of these criteria:
- Has a due date
- Base priority >= 60 (important or urgent)
- Status is `open` or `in_progress`

Use `mcp__reminders__reminders_add` with:
- `title`: task title
- `list`: deal name (e.g., "CleanerDNS", "AppEsteem") — creates the list if it doesn't exist
- `due`: due date if set
- `notes`: brief context (contact, what's needed)

When a task is completed or cancelled, use `mcp__reminders__reminders_complete` to mark it done in Reminders too.

## Obsidian Integration

Task changes automatically sync to Obsidian:
- `Tasks-Overview.md` at vault root — all active tasks by priority tier
- `Areas/{Deal}/Tasks.md` — per-deal task lists

These files are auto-generated. Don't edit them manually.
