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

/**
 * Who the export is coming from.
 *
 * The email alone does not settle it. A work seat and a personal subscription
 * are routinely the same address — this account has three organizations behind
 * one — so the organization is the part that identifies the source, and the
 * email is only there to prove which login produced it.
 */
export interface AccountIdentity {
  readonly email: string
  readonly fullName: string | null
}

/** Work or personal. Derived: claude.ai does not label an organization. */
export const OrganizationKind = {
  work: 'work',
  personal: 'personal',
} as const

export type OrganizationKind = (typeof OrganizationKind)[keyof typeof OrganizationKind]

/** An organization this session can actually read, and roughly how big it is. */
export interface OrganizationChoice {
  readonly uuid: string
  readonly name: string
  readonly kind: OrganizationKind
  /** `team_tier_1`, `enterprise`… `null` on a personal organization. */
  readonly seatTier: string | null
  /** Conversations on the first page — a floor, not a total. */
  readonly conversationsSeen: number
  /** The first page came back full, so the real number is higher. */
  readonly moreThanSeen: boolean
}

/** The capability every organization holding conversations has. */
const chatCapability = 'chat'

/** Consumer plans. An organization carrying one of these belongs to a person. */
const personalCapabilities: readonly string[] = ['claude_max', 'claude_pro']

/**
 * Can this organization hold conversations at all?
 *
 * An organization without `chat` is an API/Console one. It answers 403 to
 * `chat_conversations` — verified on a live account holding both — so it is not
 * a candidate, and probing it only spends a request to learn that.
 */
export function canHoldConversations(capabilities: readonly string[]): boolean {
  return capabilities.includes(chatCapability)
}

/**
 * Work or personal, from what claude.ai does say.
 *
 * A work seat has a seat tier; a personal organization has none, carries a
 * consumer plan as a capability, and is named after the account that minted it.
 * Nothing here is documented, so all three signals are used and the safer
 * reading wins: an organization that cannot be shown to be personal is called
 * work, because the cost of the two mistakes is not symmetric — a personal
 * export mislabelled work is a surprise, a work export mislabelled personal is
 * a false all-clear.
 */
export function classifyOrganization(
  organization: {
    readonly name: string
    readonly capabilities: readonly string[]
    readonly seatTier: string | null
  },
  email: string,
): OrganizationKind {
  if (organization.seatTier !== null) return OrganizationKind.work
  if (organization.capabilities.some((c) => personalCapabilities.includes(c))) {
    return OrganizationKind.personal
  }
  return organization.name === `${email}'s Organization`
    ? OrganizationKind.personal
    : OrganizationKind.work
}

/**
 * How many chats an organization holds, said honestly.
 *
 * Only the first page is probed, so a full page means "at least this many".
 * Rendering that as a bare `50` would invent a total the code never read.
 */
export function describeConversationCount(organization: OrganizationChoice): string {
  const noun = organization.conversationsSeen === 1 ? 'chat' : 'chats'
  return `${organization.conversationsSeen}${organization.moreThanSeen ? '+' : ''} ${noun}`
}

/** Where a run is, as far as anyone watching is concerned. */
export const ExportPhase = {
  idle: 'idle',
  awaitingSignIn: 'awaitingSignIn',
  choosingAccount: 'choosingAccount',
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
  /** Whose data this is. Known from the moment the account is read. */
  readonly identity: AccountIdentity | null
  /** Where it is being read from. `null` until resolved or chosen. */
  readonly organization: OrganizationChoice | null
  /** Only non-empty while a choice is outstanding. */
  readonly candidates: readonly OrganizationChoice[]
}

export const idleState: ExportState = {
  phase: ExportPhase.idle,
  label: '',
  percent: 0,
  summary: null,
  error: null,
  identity: null,
  organization: null,
  candidates: [],
}

/** Messages the page and the collector send to the worker. */
export const MessageKind = {
  start: 'start',
  requestState: 'requestState',
  progress: 'progress',
  awaitingSignIn: 'awaitingSignIn',
  awaitingAccountChoice: 'awaitingAccountChoice',
  chooseAccount: 'chooseAccount',
  source: 'source',
  finished: 'finished',
  failed: 'failed',
} as const

export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind]

export type ExportMessage =
  | { readonly kind: typeof MessageKind.start; readonly rangeDays: ExportRange }
  | { readonly kind: typeof MessageKind.requestState }
  | { readonly kind: typeof MessageKind.progress; readonly label: string; readonly percent: number }
  | { readonly kind: typeof MessageKind.awaitingSignIn }
  | {
      readonly kind: typeof MessageKind.awaitingAccountChoice
      readonly identity: AccountIdentity
      readonly candidates: readonly OrganizationChoice[]
    }
  | { readonly kind: typeof MessageKind.chooseAccount; readonly organizationUuid: string }
  | {
      readonly kind: typeof MessageKind.source
      readonly identity: AccountIdentity
      readonly organization: OrganizationChoice
    }
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
  account: 1,
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
