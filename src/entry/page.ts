import {
  type AccountIdentity,
  describeConversationCount,
  ExportPhase,
  type ExportState,
  type ExportSummary,
  MessageKind,
  type OrganizationChoice,
  parseExportMessage,
  parseExportRange,
} from '@/domain'

/**
 * The export page.
 *
 * A view over the worker's state and nothing more: the run is owned by
 * background.ts, so closing this tab does not stop an export, and reopening it
 * mid-run shows the run rather than the start screen.
 */

const sourceUrl = 'https://github.com/selan-ai/claude-ai-export'
const bytesPerMegabyte = 1024 * 1024

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing element: ${id}`)
  return found as T
}

class ExportPageView {
  private readonly intro = element('intro')
  private readonly running = element('running')
  private readonly status = element('status')
  private readonly statusNote = element('statusNote')
  private readonly bar = element('bar')
  private readonly percentLabel = element('pct')
  private readonly log = element('log')
  private readonly nextSteps = element('next')
  private readonly restart = element<HTMLButtonElement>('again')
  private readonly account = element('account')
  private readonly chooser = element('choose')
  private readonly organizations = element('orgs')

  constructor() {
    element<HTMLAnchorElement>('src').href = sourceUrl
    element<HTMLButtonElement>('go').addEventListener('click', () => this.start())
    this.restart.addEventListener('click', () => this.reset())

    chrome.runtime.onMessage.addListener((raw: unknown) => this.onMessage(raw))
    chrome.runtime.sendMessage(
      { kind: MessageKind.requestState },
      (state: ExportState | undefined) => this.render(state),
    )
  }

  private start(): void {
    const checked = document.querySelector<HTMLInputElement>('input[name=range]:checked')
    this.showRunning()
    this.setProgress(0, '')
    chrome.runtime.sendMessage({
      kind: MessageKind.start,
      rangeDays: parseExportRange(checked?.value ?? ''),
    })
  }

  private onMessage(raw: unknown): void {
    const message = parseExportMessage(raw)
    if (message === null) return

    if (message.kind === MessageKind.awaitingSignIn) {
      this.showAwaitingSignIn()
      return
    }
    if (message.kind === MessageKind.source) {
      this.showSource(message.identity, message.organization)
      return
    }
    if (message.kind === MessageKind.awaitingAccountChoice) {
      this.showChoice(message.identity, message.candidates)
      return
    }
    if (message.kind === MessageKind.progress) {
      this.showRunning()
      this.setProgress(message.percent, message.label)
      this.append(message.label)
      return
    }
    if (message.kind === MessageKind.finished || message.kind === MessageKind.failed) {
      chrome.runtime.sendMessage(
        { kind: MessageKind.requestState },
        (state: ExportState | undefined) => this.render(state),
      )
    }
  }

  private render(state: ExportState | undefined): void {
    if (state === undefined || state.phase === ExportPhase.idle) return

    if (state.phase === ExportPhase.awaitingSignIn) {
      this.showAwaitingSignIn()
      return
    }
    // A reopened tab must show the question, not a bar creeping along while the
    // run is in fact waiting on it.
    if (state.phase === ExportPhase.choosingAccount && state.identity !== null) {
      this.showChoice(state.identity, state.candidates)
      return
    }
    if (state.identity !== null && state.organization !== null) {
      this.showSource(state.identity, state.organization)
    }

    this.showRunning()
    this.setProgress(state.percent, state.label)
    this.append(state.label)

    if (state.phase === ExportPhase.done && state.summary !== null) this.showComplete(state.summary)
    if (state.phase === ExportPhase.failed) this.showFailure(state.error ?? 'The export stopped.')
  }

  private showRunning(): void {
    this.intro.hidden = true
    this.running.hidden = false
    this.bar.classList.remove('waiting')
    this.status.textContent = 'Exporting…'
    this.statusNote.textContent = 'Leave this tab open. It is safe to keep working elsewhere.'
  }

  /** Waiting on a person, not on work — so an indeterminate stripe, not a number. */
  private showAwaitingSignIn(): void {
    this.intro.hidden = true
    this.running.hidden = false
    this.bar.classList.add('waiting')
    // The stripe fills the track; width is set here rather than in CSS so it
    // does not have to fight the inline width every other state writes.
    this.bar.style.width = '100%'
    this.status.textContent = 'Sign in to claude.ai'
    this.statusNote.textContent =
      'We opened claude.ai in another tab. Sign in there and the export starts by itself.'
  }

  /**
   * Names the source of the export, and keeps naming it: the line stays up
   * through the run and the completion screen, so the zip in Downloads can
   * always be traced back to an account someone saw.
   */
  private showSource(identity: AccountIdentity, organization: OrganizationChoice): void {
    this.account.textContent = ''
    this.account.append(
      this.span('who', identity.email === '' ? 'Signed-in account' : identity.email),
      this.span('dim', '→'),
      this.span('who', organization.name),
      this.span(`kind ${organization.kind}`, organization.kind),
      this.span(
        'dim',
        [
          organization.seatTier,
          describeConversationCount(organization),
          organization.uuid.slice(0, 8),
        ]
          .filter((part) => part !== null)
          .join(' · '),
      ),
    )
    this.account.hidden = false
    this.chooser.hidden = true
  }

  /** More than one readable account, so the run stops here until someone picks. */
  private showChoice(identity: AccountIdentity, candidates: readonly OrganizationChoice[]): void {
    this.intro.hidden = true
    this.running.hidden = false
    this.account.hidden = true
    this.bar.classList.add('waiting')
    this.bar.style.width = '100%'
    this.status.textContent = 'Which account?'
    this.statusNote.textContent =
      identity.email === ''
        ? 'Pick the organisation to export from.'
        : `Signed in as ${identity.email}.`
    this.percentLabel.textContent = ''

    this.organizations.textContent = ''
    for (const candidate of candidates) {
      const button = document.createElement('button')
      button.type = 'button'
      button.append(
        this.span('name', candidate.name),
        this.span(`kind ${candidate.kind}`, candidate.kind),
        this.span(
          'meta',
          [candidate.seatTier, describeConversationCount(candidate), candidate.uuid.slice(0, 8)]
            .filter((part) => part !== null)
            .join(' · '),
        ),
      )
      button.addEventListener('click', () => {
        this.chooser.hidden = true
        this.showRunning()
        chrome.runtime.sendMessage({
          kind: MessageKind.chooseAccount,
          organizationUuid: candidate.uuid,
        })
      })
      this.organizations.appendChild(button)
    }
    this.chooser.hidden = false
  }

  private span(className: string, text: string): HTMLSpanElement {
    const span = document.createElement('span')
    span.className = className
    span.textContent = text
    return span
  }

  private showComplete(summary: ExportSummary): void {
    this.bar.classList.remove('waiting')
    this.status.textContent = 'Export complete'
    this.statusNote.textContent = 'Saved to your Downloads folder.'
    this.bar.style.width = '100%'
    this.percentLabel.textContent = `claude-export.zip · ${(summary.zipBytes / bytesPerMegabyte).toFixed(1)} MB`
    this.append(
      `${summary.conversations} chats · ${summary.projects} projects · ${summary.assets} files`,
      'ok',
    )
    // A short range on an account whose history is older produces an export
    // that looks successful and is nearly empty. Say so rather than let someone
    // discover it after importing.
    const held = summary.conversationsAvailable
    if (summary.rangeDays !== 0 && held > summary.conversations) {
      this.append(
        `Only ${summary.conversations} of your ${held} chats fall in the last ${summary.rangeDays} days. ` +
          'Export again with "Everything" to include the rest.',
      )
    }
    if (summary.skipped > 0) {
      this.append(`${summary.skipped} item(s) could not be fetched — listed in skipped.json`)
    }
    this.nextSteps.hidden = false
    this.restart.hidden = false
  }

  private showFailure(error: string): void {
    this.bar.classList.remove('waiting')
    this.bar.classList.add('failed')
    this.status.textContent = 'Could not finish'
    this.statusNote.textContent = 'Nothing was saved.'
    this.percentLabel.textContent = ''
    this.append(error, 'err')
    this.restart.hidden = false
  }

  private setProgress(percent: number, label: string): void {
    this.bar.style.width = `${percent}%`
    this.percentLabel.textContent = label === '' ? 'Preparing…' : `${label} · ${percent}%`
  }

  /** Reopening the page replays state, so repeats are dropped rather than stacked. */
  private append(text: string, className = ''): void {
    if (text === '') return
    if (this.log.lastElementChild?.textContent === text) return
    const row = document.createElement('div')
    if (className !== '') row.className = className
    row.textContent = text
    this.log.appendChild(row)
    this.log.scrollTop = this.log.scrollHeight
  }

  private reset(): void {
    this.log.textContent = ''
    this.account.hidden = true
    this.account.textContent = ''
    this.chooser.hidden = true
    this.organizations.textContent = ''
    this.nextSteps.hidden = true
    this.restart.hidden = true
    this.bar.classList.remove('failed', 'waiting')
    this.bar.style.width = '0%'
    this.running.hidden = true
    this.intro.hidden = false
  }
}

new ExportPageView()
