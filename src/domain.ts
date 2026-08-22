/**
 * Shared vocabulary. Everything crossing a process boundary — page to worker,
 * worker to collector — is described here once.
 */

/**
 * How far back to export, in days. Zero means everything.
 *
 * Declared as a frozen object rather than a TypeScript `enum` because these
 * values arrive as strings from a radio input: a nominal enum would need a cast
 * at every read, and the cast is precisely the check you wanted.
 */
export const ExportRange = {
  lastThirtyDays: 30,
  lastNinetyDays: 90,
  everything: 0,
} as const

export type ExportRange = (typeof ExportRange)[keyof typeof ExportRange]

const exportRangeValues: readonly number[] = Object.values(ExportRange)

/**
 * Radio inputs hand back strings. Anything unrecognised degrades to the default.
 *
 * The empty string is rejected before `Number`, which would turn it into 0 —
 * and 0 is a real range meaning *everything*. A missing selection would
 * otherwise silently export a person's entire history.
 */
export function parseExportRange(raw: string): ExportRange {
  if (raw.trim() === '') return ExportRange.lastThirtyDays
  const days = Number(raw)
  return exportRangeValues.includes(days) ? (days as ExportRange) : ExportRange.lastThirtyDays
}

/** Where a run is, as far as anyone watching is concerned. */
export const ExportPhase = {
  idle: 'idle',
  awaitingSignIn: 'awaitingSignIn',
  running: 'running',
  done: 'done',
  failed: 'failed',
} as const

export type ExportPhase = (typeof ExportPhase)[keyof typeof ExportPhase]

/** What the run produced. Counts only — never conversation content. */
export interface ExportSummary {
  readonly conversations: number
  /**
   * How many conversations the account has in total, before the date window.
   * Carried so the page can say "1 of 366" — a short range on an old account
   * produces an export that looks fine and is nearly empty.
   */
  readonly conversationsAvailable: number
  readonly messages: number
  readonly projects: number
  readonly documents: number
  readonly assets: number
  readonly scheduledTasks: number
  readonly skipped: number
  readonly rangeDays: ExportRange
  readonly zipBytes: number
}

/** An item that could not be fetched. Losing data silently is the failure mode. */
export interface SkippedItem {
  readonly kind: 'conversation' | 'file' | 'project'
  readonly uuid: string
  readonly name: string
  readonly reason: string
}

/**
 * The worker's view of a run. The page renders this and nothing else, so
 * reopening the tab mid-export shows the run rather than the start screen.
 */
export interface ExportState {
  readonly phase: ExportPhase
  readonly label: string
  readonly percent: number
  readonly summary: ExportSummary | null
  readonly error: string | null
}

export const idleState: ExportState = {
  phase: ExportPhase.idle,
  label: '',
  percent: 0,
  summary: null,
  error: null,
}

/** Messages the page and the collector send to the worker. */
export const MessageKind = {
  start: 'start',
  requestState: 'requestState',
  progress: 'progress',
  awaitingSignIn: 'awaitingSignIn',
  finished: 'finished',
  failed: 'failed',
} as const

export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind]

export type ExportMessage =
  | { readonly kind: typeof MessageKind.start; readonly rangeDays: ExportRange }
  | { readonly kind: typeof MessageKind.requestState }
  | { readonly kind: typeof MessageKind.progress; readonly label: string; readonly percent: number }
  | { readonly kind: typeof MessageKind.awaitingSignIn }
  | { readonly kind: typeof MessageKind.finished; readonly summary: ExportSummary }
  | { readonly kind: typeof MessageKind.failed; readonly error: string }

/**
 * `chrome.runtime.onMessage` is typed as `any` and anything on the machine
 * holding an extension id can post to it, so narrow before use.
 */
export function parseExportMessage(value: unknown): ExportMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const kind = (value as { kind?: unknown }).kind
  if (typeof kind !== 'string' || !(kind in MessageKind)) return null
  return value as ExportMessage
}

/**
 * Progress is a share of the whole job, never of one stage. Reading chats is
 * most of the wall-clock, but downloading attachments and building the zip are
 * not free — a bar that reached 100% at the end of the chats would sit there
 * lying for a minute. Only a saved zip reaches 100.
 */
export const ProgressStop = {
  listing: 2,
  chatsStart: 5,
  chatsEnd: 70,
  projects: 72,
  scheduledTasks: 76,
  assetsStart: 78,
  assetsEnd: 95,
  buildingArchive: 96,
  saving: 98,
  complete: 100,
} as const

/** The highest a run in flight may report. 100 is reserved for a saved file. */
export const maxInFlightPercent = 98
