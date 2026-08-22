import { ZipArchive } from '@/archive/ZipArchive'
import { type ApiConversationSummary, ClaudeApi } from '@/claude/ClaudeApi'
import { ExportMapper, type ImportConversation, type ImportProject } from '@/claude/ExportMapper'
import { ExportRange, type ExportSummary, ProgressStop, type SkippedItem } from '@/domain'

/** Reports where the run is. Implemented by the collector's message channel. */
export interface ProgressSink {
  report(label: string, percent: number): void
}

/** Hands the finished archive to the user. Separated so tests need no DOM. */
export interface ArchiveSink {
  deliver(fileName: string, blob: Blob): void
}

export interface ExportOptions {
  readonly rangeDays: ExportRange
  readonly progress: ProgressSink
  readonly archive: ArchiveSink
}

const requestGapMs = 150
const concurrency = 4
const millisecondsPerDay = 86_400_000
const archiveName = 'claude-export.zip'
/** The importer refuses anything larger. */
const maxArchiveBytes = 1024 ** 3

function interpolate(from: number, to: number, done: number, total: number): number {
  if (total <= 0) return to
  return from + ((to - from) * done) / total
}

/**
 * One export, start to finish.
 *
 * Runs inside a claude.ai page, because that is the only context whose requests
 * carry the session cookie. Failures to fetch an individual item are recorded
 * in `skipped.json` rather than aborting the run — a partial export the user
 * knows about beats no export, and silent loss is the thing to avoid.
 */
export class ExportSession {
  private readonly mapper = new ExportMapper()
  private readonly skipped: SkippedItem[] = []
  private available = 0

  constructor(private readonly options: ExportOptions) {}

  async run(): Promise<ExportSummary> {
    const api = new ClaudeApi(await this.resolveOrganization())

    const conversations = await this.collectConversations(api)
    const projects = await this.collectProjects(api)

    this.options.progress.report('Reading scheduled tasks', ProgressStop.scheduledTasks)
    const scheduledTasks = await api.listScheduledTasks()

    const assets = await this.collectAssets(api, conversations, projects)

    return this.buildArchive(conversations, projects, scheduledTasks, assets)
  }

  /**
   * An account can belong to several organizations, and a session is not
   * always allowed to read all of them. Probing tells "empty" apart from
   * "forbidden", so a 403 on one never results in silently exporting nothing.
   */
  private async resolveOrganization(): Promise<string> {
    const organizations = await ClaudeApi.listOrganizations()
    if (organizations.length === 0) {
      throw new Error('No organizations on this account. Are you signed in to claude.ai?')
    }
    const only = organizations[0]
    if (organizations.length === 1 && only !== undefined) return only.uuid

    const probes = await Promise.all(
      organizations.map(async (organization) => ({
        organization,
        ...(await ClaudeApi.probeOrganization(organization.uuid)),
      })),
    )

    const usable = probes.filter((p) => p.readable && p.count > 0).sort((a, b) => b.count - a.count)
    const best = usable[0]
    if (best === undefined) {
      throw new Error('None of your organizations returned any conversations.')
    }
    return best.organization.uuid
  }

  private async collectConversations(api: ClaudeApi): Promise<readonly ImportConversation[]> {
    const headers = await api.listConversations((total) =>
      this.options.progress.report(`Listing conversations — ${total} so far`, ProgressStop.listing),
    )

    this.available = headers.length
    const selected = this.withinRange(headers)
    const noun = selected.length === 1 ? 'chat' : 'chats'
    this.options.progress.report(`Reading ${selected.length} ${noun}`, ProgressStop.chatsStart)

    let done = 0
    const trees = await this.pooled(selected, async (header) => {
      const conversation = await api.getConversation(header.uuid).catch(() => null)
      done += 1
      this.options.progress.report(
        `Reading chats — ${done} of ${selected.length}`,
        interpolate(ProgressStop.chatsStart, ProgressStop.chatsEnd, done, selected.length),
      )
      if (conversation === null) {
        this.skip('conversation', header.uuid, header.name ?? '', 'could not be fetched')
        return null
      }
      return this.mapper.mapConversation(conversation)
    })

    return trees.filter((c): c is ImportConversation => c !== null)
  }

  /** Filtered on last activity, so an old thread replied to yesterday still comes along. */
  private withinRange(
    headers: readonly ApiConversationSummary[],
  ): readonly ApiConversationSummary[] {
    if (this.options.rangeDays === ExportRange.everything) return headers
    const cutoff = Date.now() - this.options.rangeDays * millisecondsPerDay
    return headers.filter((header) => {
      const stamp = Date.parse(header.updated_at ?? header.created_at ?? '')
      return Number.isNaN(stamp) ? true : stamp >= cutoff
    })
  }

  private async collectProjects(api: ClaudeApi): Promise<readonly ImportProject[]> {
    this.options.progress.report('Reading projects', ProgressStop.projects)
    const summaries = await api.listProjects()

    return this.pooled(summaries, async (summary) => {
      const [detail, documents, files] = await Promise.all([
        api.getProject(summary.uuid),
        api.listProjectDocuments(summary.uuid),
        api.listProjectFiles(summary.uuid),
      ])
      return this.mapper.mapProject({ ...summary, ...(detail ?? {}) }, documents, files)
    })
  }

  private async collectAssets(
    api: ClaudeApi,
    conversations: readonly ImportConversation[],
    projects: readonly ImportProject[],
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    const wanted = new Map<string, string>()
    for (const conversation of conversations) {
      for (const message of conversation.chat_messages) {
        for (const file of message.files) wanted.set(file.file_uuid, file.file_name ?? '')
      }
    }
    for (const project of projects) {
      for (const file of project.files) wanted.set(file.file_uuid, file.file_name ?? '')
    }

    const total = wanted.size
    this.options.progress.report(
      `Downloading ${total} file${total === 1 ? '' : 's'}`,
      ProgressStop.assetsStart,
    )

    const downloaded = new Map<string, Uint8Array>()
    let done = 0
    await this.pooled([...wanted.keys()], async (uuid) => {
      const bytes = await api.downloadFile(uuid)
      done += 1
      this.options.progress.report(
        `Downloading files — ${done} of ${total}`,
        interpolate(ProgressStop.assetsStart, ProgressStop.assetsEnd, done, total),
      )
      if (bytes === null) this.skip('file', uuid, wanted.get(uuid) ?? '', 'download failed')
      else downloaded.set(uuid, bytes)
      return null
    })

    return downloaded
  }

  private buildArchive(
    conversations: readonly ImportConversation[],
    projects: readonly ImportProject[],
    scheduledTasks: unknown,
    assets: ReadonlyMap<string, Uint8Array>,
  ): ExportSummary {
    this.options.progress.report('Building the zip', ProgressStop.buildingArchive)

    const archive = new ZipArchive()
    archive.addJson('conversations.json', conversations)
    archive.addJson('projects.json', projects)
    archive.addJson('users.json', [{ uuid: crypto.randomUUID() }])
    // Read by the schedule importer, ignored by Claude Desktop's.
    archive.addJson('schedules.json', scheduledTasks ?? { unavailable: true })
    archive.addJson('skipped.json', this.skipped)
    archive.addJson('blocktypes.json', this.mapper.diagnostics)
    // manifest.json is deliberately absent: supplied and disagreeing by even
    // one message, the import fails with IMPORT_MANIFEST_MISMATCH. Omitted, the
    // importer derives it from the data and it can never disagree.
    for (const [uuid, bytes] of assets) archive.addBytes(`files/${uuid}`, bytes)

    this.options.progress.report('Saving to Downloads', ProgressStop.saving)
    const blob = archive.toBlob()
    if (blob.size > maxArchiveBytes) {
      throw new Error('Export exceeds the 1 GiB import limit. Choose a shorter date range.')
    }
    this.options.archive.deliver(archiveName, blob)

    const tasks = Array.isArray(scheduledTasks)
      ? scheduledTasks.length
      : Array.isArray((scheduledTasks as { data?: unknown } | null)?.data)
        ? (scheduledTasks as { data: unknown[] }).data.length
        : 0

    return {
      conversations: conversations.length,
      conversationsAvailable: this.available,
      messages: conversations.reduce((sum, c) => sum + c.chat_messages.length, 0),
      projects: projects.length,
      documents: projects.reduce((sum, p) => sum + p.docs.length, 0),
      assets: assets.size,
      scheduledTasks: tasks,
      skipped: this.skipped.length,
      rangeDays: this.options.rangeDays,
      zipBytes: blob.size,
    }
  }

  private skip(kind: SkippedItem['kind'], uuid: string, name: string, reason: string): void {
    this.skipped.push({ kind, uuid, name, reason })
  }

  /** Bounded concurrency with a gap between requests, to stay under rate limits. */
  private async pooled<TIn, TOut>(
    items: readonly TIn[],
    worker: (item: TIn) => Promise<TOut>,
  ): Promise<readonly TOut[]> {
    const results = new Array<TOut>(items.length)
    let cursor = 0

    const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        const item = items[index]
        if (item === undefined) continue
        results[index] = await worker(item)
        await new Promise((resolve) => setTimeout(resolve, requestGapMs))
      }
    })

    await Promise.all(lanes)
    return results
  }
}
