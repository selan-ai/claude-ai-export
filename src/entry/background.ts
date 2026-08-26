import {
  ExportPhase,
  type ExportRange,
  type ExportState,
  idleState,
  MessageKind,
  maxInFlightPercent,
  parseExportMessage,
} from '@/domain'

/**
 * Owns a run.
 *
 * The UI cannot: a popup dies the moment focus moves, and even a tab can be
 * closed mid-export. The collecting itself happens in the claude.ai page and
 * survives this worker being shut down; what lives here is the state a
 * reopened page needs in order to show a run already in progress.
 */
class ExportCoordinator {
  private state: ExportState = idleState
  private pageTabId: number | null = null
  /** The claude.ai tab running the collector. A content script is only
   * reachable through its tab, so an account choice needs this to get back. */
  private claudeTabId: number | null = null

  get currentState(): ExportState {
    return this.state
  }

  /** Opens the export page, or focuses the one already open. */
  async openPage(): Promise<void> {
    if (this.pageTabId !== null) {
      const existing = await chrome.tabs.get(this.pageTabId).catch(() => null)
      if (existing?.id !== undefined) {
        await chrome.tabs.update(existing.id, { active: true })
        if (existing.windowId !== undefined) {
          await chrome.windows.update(existing.windowId, { focused: true })
        }
        return
      }
      this.pageTabId = null
    }
    const created = await chrome.tabs.create({ url: chrome.runtime.getURL('export.html') })
    this.pageTabId = created.id ?? null
  }

  async start(rangeDays: ExportRange): Promise<void> {
    this.state = {
      phase: ExportPhase.running,
      label: 'Starting…',
      percent: 0,
      summary: null,
      error: null,
      identity: null,
      organization: null,
      candidates: [],
    }

    try {
      const tabId = await this.claudeTab()
      this.claudeTabId = tabId

      if (!(await this.hasSession(tabId))) {
        this.state = {
          ...this.state,
          phase: ExportPhase.awaitingSignIn,
          label: 'Waiting for sign-in',
        }
        this.notify({ kind: MessageKind.awaitingSignIn })
        if (!(await this.waitForSignIn(tabId))) {
          if (this.state.phase === ExportPhase.awaitingSignIn) {
            this.fail('Timed out waiting for sign-in to claude.ai.')
          }
          return
        }
        this.state = { ...this.state, phase: ExportPhase.running, label: 'Signed in — starting…' }
        if (this.pageTabId !== null) {
          await chrome.tabs.update(this.pageTabId, { active: true }).catch(() => null)
        }
      }

      await chrome.scripting.executeScript({
        target: { tabId },
        func: (days: string) => {
          globalThis.__claudeExportRangeDays = days
        },
        args: [String(rangeDays)],
      })

      // Not awaited on purpose: the page keeps collecting whatever happens to
      // this worker, and progress arrives by message.
      void chrome.scripting
        .executeScript({ target: { tabId }, files: ['collector.js'] })
        .catch((error: unknown) =>
          this.fail(error instanceof Error ? error.message : String(error)),
        )
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Hands a chosen organization to the collector.
   *
   * `runtime.sendMessage` from the page reaches this worker and every extension
   * page, but never a content script — so the last hop has to be addressed to
   * the tab.
   */
  async relayChoice(organizationUuid: string): Promise<void> {
    const tabId = this.claudeTabId
    if (tabId === null) return
    this.state = {
      ...this.state,
      phase: ExportPhase.running,
      label: 'Starting…',
      candidates: [],
    }
    await chrome.tabs
      .sendMessage(tabId, { kind: MessageKind.chooseAccount, organizationUuid })
      .catch(() => this.fail('The claude.ai tab closed before the export could start.'))
  }

  apply(message: ReturnType<typeof parseExportMessage>): void {
    if (message === null) return
    switch (message.kind) {
      case MessageKind.source:
        this.state = {
          ...this.state,
          identity: message.identity,
          organization: message.organization,
          candidates: [],
        }
        break
      case MessageKind.awaitingAccountChoice:
        this.state = {
          ...this.state,
          phase: ExportPhase.choosingAccount,
          label: 'Waiting for an account',
          identity: message.identity,
          candidates: message.candidates,
        }
        break
      case MessageKind.progress:
        this.state = {
          ...this.state,
          label: message.label,
          // Clamped regardless of what the page claims: only a saved file is 100.
          percent: Math.min(maxInFlightPercent, Math.round(message.percent)),
        }
        break
      case MessageKind.finished:
        this.state = {
          ...this.state,
          phase: ExportPhase.done,
          label: 'Export complete',
          percent: 100,
          summary: message.summary,
          error: null,
          candidates: [],
        }
        break
      case MessageKind.failed:
        this.fail(message.error)
        break
      default:
        break
    }
  }

  /** Reuses an open claude.ai tab, else opens one without stealing focus. */
  private async claudeTab(): Promise<number> {
    const [existing] = await chrome.tabs.query({ url: 'https://claude.ai/*' })
    if (existing?.id !== undefined) return existing.id

    const created = await chrome.tabs.create({ url: 'https://claude.ai/', active: false })
    const tabId = created.id
    if (tabId === undefined) throw new Error('Could not open claude.ai.')

    await new Promise<void>((resolve) => {
      const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo): void => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated)
          resolve()
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated)
    })
    return tabId
  }

  /**
   * A signed-out visitor still gets 200 from some endpoints, so a usable
   * session means an account with at least one organization — not merely a
   * response.
   */
  private async hasSession(tabId: number): Promise<boolean> {
    const [result] = await chrome.scripting
      .executeScript({
        target: { tabId },
        func: async () => {
          try {
            const response = await fetch('/api/bootstrap', {
              credentials: 'include',
              cache: 'no-store',
            })
            if (!response.ok) return false
            const body = (await response.json()) as {
              account?: { memberships?: unknown[] } | null
            }
            return (body.account?.memberships?.length ?? 0) > 0
          } catch {
            return false
          }
        },
      })
      .catch(() => [{ result: false }])
    return result?.result === true
  }

  /** Polling doubles as a keepalive, so the worker is not shut down mid-wait. */
  private async waitForSignIn(tabId: number): Promise<boolean> {
    await chrome.tabs.update(tabId, { active: true })
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      if (this.state.phase !== ExportPhase.awaitingSignIn) return false
      if (await this.hasSession(tabId)) return true
    }
    return false
  }

  private fail(error: string): void {
    this.state = { ...this.state, phase: ExportPhase.failed, error }
  }

  private notify(message: { kind: string }): void {
    try {
      chrome.runtime.sendMessage(message)
    } catch {
      // No page open. Its next request for state will catch up.
    }
  }
}

const coordinator = new ExportCoordinator()

chrome.action.onClicked.addListener(() => void coordinator.openPage())

chrome.runtime.onMessage.addListener((raw: unknown, _sender, respond) => {
  const message = parseExportMessage(raw)
  if (message === null) return false

  if (message.kind === MessageKind.start) {
    void coordinator.start(message.rangeDays)
    respond({ accepted: true })
    return true
  }
  if (message.kind === MessageKind.requestState) {
    respond(coordinator.currentState)
    return true
  }
  if (message.kind === MessageKind.chooseAccount) {
    void coordinator.relayChoice(message.organizationUuid)
    respond({ accepted: true })
    return true
  }

  coordinator.apply(message)
  return false
})
