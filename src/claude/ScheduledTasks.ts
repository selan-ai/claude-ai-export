/**
 * Scheduled tasks, and why they need a separate step.
 *
 * Claude Desktop's importer reads five things out of the archive —
 * conversations.json, projects.json, users.json, manifest.json and files/ —
 * and nothing else. There is no field for a schedule anywhere in that schema,
 * so no archive can carry one.
 *
 * Desktop's own scheduled tasks are not server data either: they are a local
 * JSON record plus a skill file on disk. A browser cannot write those, so the
 * supported route is Desktop's `create_scheduled_task` tool, driven by a prompt
 * the person pastes into a Cowork session once.
 *
 * What this module does is make that paste correct — above all the timezone,
 * which is the part nobody would notice was wrong until a Monday message
 * arrived at five in the morning.
 */

/** The task shape claude.ai returns from `cowork/scheduled_tasks`. */
export interface ApiScheduledTask {
  readonly id: string
  readonly name: string | null
  readonly cron_expression: string | null
  readonly run_once_at: string | null
  readonly next_run_at: string | null
  readonly enabled: boolean
  readonly job_config: {
    readonly ccr: {
      readonly events: readonly {
        readonly data: { readonly message: { readonly content: string | null } | null } | null
      }[]
    } | null
  } | null
}

export interface PreparedTask {
  readonly name: string
  /** Cron in the reader's local time, which is what Desktop schedules against. */
  readonly cron: string | null
  readonly fireAt: string | null
  readonly enabled: boolean
  readonly prompt: string
  /** True when the cron was too complex to convert and was left as-is. */
  readonly timeUnverified: boolean
}

/** Anything beyond a plain daily or weekly rule is left alone and flagged. */
const simpleCron = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|\d)$/

/**
 * claude.ai stores cron in UTC; Desktop runs it in the machine's local time.
 *
 * The instant in `next_run_at` carries the scheduler's jitter — an 05:00 rule
 * reports 05:05 — so the minute and hour come from the cron itself, and
 * `next_run_at` is used only to pin the date, which is what decides whether
 * daylight saving is in effect.
 */
export function cronToLocal(cron: string, nextRunAt: string): { cron: string; converted: boolean } {
  const parts = simpleCron.exec(cron.trim())
  if (parts === null) return { cron, converted: false }

  const minute = Number(parts[1])
  const hour = Number(parts[2])
  const dayOfWeek = parts[3] ?? '*'

  const stamp = Date.parse(nextRunAt)
  const at = Number.isNaN(stamp) ? new Date() : new Date(stamp)
  at.setUTCHours(hour, minute, 0, 0)

  const localDayOfWeek = dayOfWeek === '*' ? '*' : String(at.getDay())
  return { cron: `${at.getMinutes()} ${at.getHours()} * * ${localDayOfWeek}`, converted: true }
}

/** claude.ai keeps the prompt well inside job_config, not as a top-level field. */
export function promptOf(task: ApiScheduledTask): string {
  const events = task.job_config?.ccr?.events ?? []
  const content = events[0]?.data?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

/** Reads the list out of whichever shape the endpoint returned. */
export function tasksFrom(payload: unknown): readonly ApiScheduledTask[] {
  if (Array.isArray(payload)) return payload as ApiScheduledTask[]
  const data = (payload as { data?: unknown } | null)?.data
  return Array.isArray(data) ? (data as ApiScheduledTask[]) : []
}

export function prepare(payload: unknown): readonly PreparedTask[] {
  return tasksFrom(payload)
    .map((task) => {
      const prompt = promptOf(task)
      if (prompt === '') return null

      const source = task.cron_expression
      const converted =
        source === null
          ? { cron: null, converted: true }
          : cronToLocal(source, task.next_run_at ?? '')

      return {
        name: typeof task.name === 'string' && task.name !== '' ? task.name : 'Untitled task',
        cron: converted.cron,
        fireAt: task.run_once_at,
        enabled: task.enabled !== false,
        prompt,
        timeUnverified: source !== null && !converted.converted,
      } satisfies PreparedTask
    })
    .filter((task): task is PreparedTask => task !== null)
}

/**
 * The text a person pastes into a Cowork session. Written as instructions to
 * Claude rather than as a form, because `create_scheduled_task` is a tool it
 * calls — and told to check for existing tasks first, so pasting twice does not
 * produce two copies of everything.
 */
export function coworkPrompt(tasks: readonly PreparedTask[], timeZone: string): string {
  const body = tasks
    .map((task) => {
      const schedule = task.cron
        ? `cronExpression: ${task.cron}`
        : task.fireAt
          ? `fireAt: ${task.fireAt}`
          : 'no schedule — create it as an ad-hoc task'
      const disabled = task.enabled ? '' : '\nenabled: false (leave this one turned off)\n'
      return `\n---\nname: ${task.name}\n${schedule}\n${disabled}\nprompt:\n${task.prompt}\n`
    })
    .join('')

  return (
    `Create these scheduled tasks with the create_scheduled_task MCP tool.\n\n` +
    `Call list_scheduled_tasks first and skip any that already exist, so running this ` +
    `twice does not duplicate them. Report each task's next run time when you are done.\n\n` +
    `The cron expressions below are already in local time (${timeZone}) — claude.ai ` +
    `stores them in UTC, and they have been converted. Use them exactly as written.\n` +
    body
  )
}
