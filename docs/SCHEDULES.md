# Schedule importer

Chats, projects and assets ride the zip. Scheduled tasks do not — no export
format carries them. But they don't need hand-retyping either: claude.ai
exposes them over REST, and Claude Desktop can create them over MCP.

## 1. Export (already done)

`export-claudeai.js` pulls `GET /api/organizations/{ORG}/cowork/scheduled_tasks`
and writes the result to `schedules.json` inside the zip. The importer ignores
that member, so it is safe to leave in place.

The response is `{ "data": [ … ] }`. Each task carries `id`, `name`,
`cron_expression`, `next_run_at`, `last_fired_at`, `enabled`, `created_via`,
`notifications`, `mcp_connections`, and `job_config`.

The prompt is **not** a top-level field. It sits at:

    job_config.ccr.events[0].data.message.content

`mcp_connections` lists the connectors the task used (Google Drive and such).
Those do not transfer — the task will run in Desktop against whatever
connectors Desktop has. Check any task that depended on one.

## 2. Import

Unzip `schedules.json` somewhere readable, open Claude Desktop (3P), start a
Cowork session and paste:

```
Read schedules.json at <path>. For each entry, create a scheduled task with the
create_scheduled_task MCP tool:

  name            <- name
  prompt          <- job_config.ccr.events[0].data.message.content, verbatim
  cronExpression  <- cron_expression, when set
  fireAt          <- run_once_at, when set instead
  (omit both if the source task has neither — that is an ad-hoc task)

Call list_scheduled_tasks first and skip anything already present, so re-running
this does not duplicate. Leave tasks whose `enabled` is false disabled. When
done, list every task you created with its next run time, and separately list
anything you skipped and why.
```

## 3. Verify

`list_scheduled_tasks`, then check each next-run time against `next_run_at` from
the source. Timezone is the main thing that drifts: claude.ai stores cron in the
task's own zone, Desktop runs against the machine's local zone.
