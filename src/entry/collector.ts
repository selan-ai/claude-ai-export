import { type ExportMessage, MessageKind, maxInFlightPercent, parseExportRange } from '@/domain'
import { type ArchiveSink, ExportSession, type ProgressSink } from '@/export/ExportSession'

/**
 * Injected into a claude.ai tab. This is the only file that runs with the
 * user's session, and it neither reads nor transmits the cookie that carries it.
 */

declare global {
  // Set by the worker immediately before this script is injected; both share
  // one isolated world, so a global is the only channel executeScript offers.
  var __claudeExportRangeDays: string | undefined
}

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
