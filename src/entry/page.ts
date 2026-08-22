import {
  ExportPhase,
  type ExportState,
  type ExportSummary,
  MessageKind,
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
    this.nextSteps.hidden = true
    this.restart.hidden = true
    this.bar.classList.remove('failed', 'waiting')
    this.bar.style.width = '0%'
    this.running.hidden = true
    this.intro.hidden = false
  }
}

new ExportPageView()
