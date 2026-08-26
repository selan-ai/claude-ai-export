import {
  type AccountIdentity,
  type ExportMessage,
  MessageKind,
  maxInFlightPercent,
  type OrganizationChoice,
  parseExportMessage,
  parseExportRange,
} from '@/domain'
import {
  type AccountChooser,
  type ArchiveSink,
  ExportSession,
  type ProgressSink,
  type SourceSink,
} from '@/export/ExportSession'

/**
 * Injected into a claude.ai tab. This is the only file that runs with the
 * user's session, and it neither reads nor transmits the cookie that carries it.
 */

declare global {
  // Set by the worker immediately before this script is injected; both share
  // one isolated world, so a global is the only channel executeScript offers.
  var __claudeExportRangeDays: string | undefined
}

/** As long as the worker waits for a sign-in. Both wait on the same person. */
const choiceTimeoutMs = 10 * 60_000

function post(message: ExportMessage): void {
  try {
    chrome.runtime.sendMessage(message)
  } catch {
    // The page may be closed and the worker asleep. Neither should stop a run.
  }
}

class MessageProgress implements ProgressSink {
  report(label: string, percent: number): void {
    post({
      kind: MessageKind.progress,
      label,
      percent: Math.min(maxInFlightPercent, Math.round(percent)),
    })
  }
}

class MessageSource implements SourceSink {
  announce(identity: AccountIdentity, organization: OrganizationChoice): void {
    post({ kind: MessageKind.source, identity, organization })
  }
}

/**
 * Puts the question on the export page and waits for an answer.
 *
 * The reply cannot come straight back: `runtime.sendMessage` from a page never
 * reaches a content script, so the worker relays it with `tabs.sendMessage`,
 * which does. Bounded, because the page holding the question can be closed —
 * and a run that waits forever is worse than one that says why it stopped.
 */
class MessageChooser implements AccountChooser {
  async choose(
    identity: AccountIdentity,
    candidates: readonly OrganizationChoice[],
  ): Promise<OrganizationChoice> {
    post({ kind: MessageKind.awaitingAccountChoice, identity, candidates })

    const uuid = await new Promise<string | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const listener = (raw: unknown): void => {
        const message = parseExportMessage(raw)
        if (message === null || message.kind !== MessageKind.chooseAccount) return
        clearTimeout(timer)
        chrome.runtime.onMessage.removeListener(listener)
        resolve(message.organizationUuid)
      }
      timer = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener)
        resolve(null)
      }, choiceTimeoutMs)
      chrome.runtime.onMessage.addListener(listener)
    })

    if (uuid === null) {
      throw new Error('No account was picked, so nothing was exported. Start again when ready.')
    }
    const chosen = candidates.find((candidate) => candidate.uuid === uuid)
    if (chosen === undefined) {
      throw new Error('That account is no longer one of the options. Start again.')
    }
    return chosen
  }
}

class DownloadSink implements ArchiveSink {
  deliver(fileName: string, blob: Blob): void {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

async function main(): Promise<void> {
  const session = new ExportSession({
    rangeDays: parseExportRange(globalThis.__claudeExportRangeDays ?? ''),
    progress: new MessageProgress(),
    archive: new DownloadSink(),
    chooser: new MessageChooser(),
    source: new MessageSource(),
  })

  try {
    post({ kind: MessageKind.finished, summary: await session.run() })
  } catch (error) {
    post({
      kind: MessageKind.failed,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

void main()
