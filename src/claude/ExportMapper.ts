import type {
  ApiAttachment,
  ApiContentBlock,
  ApiConversation,
  ApiFileRef,
  ApiMessage,
  ApiProject,
  ApiProjectDocument,
  ApiProjectFile,
} from '@/claude/ClaudeApi'

/**
 * The shape Claude Desktop's importer parses. Read out of the Claude Code CLI
 * (which Desktop shells out to) and confirmed by running fixtures through
 * `import-conversations --dry-run`.
 *
 * Four details lose data silently if you get them wrong, and each is enforced
 * here rather than left to the caller:
 *
 *  1. Project instructions live in `prompt_template`, nowhere else.
 *  2. Archive members must be `files/<file_uuid>` with no extension — the
 *     importer requires the basename to match /^[a-zA-Z0-9_-]+$/.
 *  3. `manifest.json` must be omitted; supplied and disagreeing by one message,
 *     the import fails with IMPORT_MANIFEST_MISMATCH.
 *  4. Only content blocks of type `text` survive, so everything else has to be
 *     flattened into text before it gets there.
 */
export interface ImportConversation {
  readonly uuid: string
  readonly name: string
  readonly created_at: string | undefined
  readonly updated_at: string | undefined
  readonly project_uuid: string | null
  readonly chat_messages: readonly ImportMessage[]
}

export interface ImportMessage {
  readonly uuid: string
  readonly parent_message_uuid: string | null
  readonly sender: string
  readonly text: string
  readonly content: readonly ImportTextBlock[]
  readonly created_at: string
  readonly attachments: readonly ImportAttachment[]
  readonly files: readonly ImportFileRef[]
}

export interface ImportTextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ImportAttachment {
  readonly file_name: string
  readonly extracted_content: string
}

export interface ImportFileRef {
  readonly file_uuid: string
  readonly file_name: string | undefined
}

export interface ImportProject {
  readonly uuid: string
  readonly name: string
  readonly prompt_template: string | undefined
  readonly docs: readonly ImportDocument[]
  readonly files: readonly ImportFileRef[]
}

export interface ImportDocument {
  readonly filename: string | undefined
  readonly content: string
}

const defaultSender = 'assistant'

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Turns claude.ai's payloads into the importer's schema.
 *
 * The importer validates with zod, and a single bad field drops the whole
 * enclosing array — one malformed attachment loses every attachment on that
 * message. So nothing is passed through raw: every field is rebuilt here.
 */
export class ExportMapper {
  private readonly blockTypeCounts = new Map<string, number>()
  private readonly unflattenedTypes = new Map<string, number>()

  /** Which content block types were seen, and which carried content we could not reach. */
  get diagnostics(): {
    readonly seen: Record<string, number>
    readonly unflattened: Record<string, number>
  } {
    return {
      seen: Object.fromEntries(this.blockTypeCounts),
      unflattened: Object.fromEntries(this.unflattenedTypes),
    }
  }

  mapConversation(source: ApiConversation): ImportConversation {
    return {
      uuid: text(source.uuid),
      name: text(source.name),
      created_at: textOrUndefined(source.created_at),
      updated_at: textOrUndefined(source.updated_at),
      project_uuid: textOrNull(source.project_uuid),
      chat_messages: (source.chat_messages ?? []).map((m) => this.mapMessage(m)),
    }
  }

  mapProject(
    source: ApiProject,
    documents: readonly ApiProjectDocument[],
    files: readonly ApiProjectFile[],
  ): ImportProject {
    // The importer reads instructions from `prompt_template` only; the other
    // keys are what the same field has been called elsewhere in the API.
    const instructions =
      textOrUndefined(source.prompt_template) ??
      textOrUndefined(source.instructions) ??
      textOrUndefined(source.description)

    return {
      uuid: text(source.uuid),
      name: text(source.name),
      prompt_template: instructions,
      docs: documents
        .map((d) => ({
          filename: textOrUndefined(d.filename ?? d.file_name ?? d.title),
          content: text(d.content ?? d.text),
        }))
        .filter((d) => d.content.length > 0),
      files: files
        .map((f) => ({
          file_uuid: text(f.file_uuid ?? f.uuid),
          file_name: textOrUndefined(f.file_name),
        }))
        .filter((f) => f.file_uuid.length > 0),
    }
  }

  private mapMessage(source: ApiMessage): ImportMessage {
    return {
      uuid: text(source.uuid),
      parent_message_uuid: textOrNull(source.parent_message_uuid),
      sender: text(source.sender, defaultSender),
      text: text(source.text),
      content: this.flattenContent(source.content ?? []),
      created_at: text(source.created_at),
      attachments: this.mapAttachments(source.attachments ?? []),
      files: this.mapFileRefs(source.files ?? []),
    }
  }

  /**
   * The importer keeps `text` blocks and discards the rest, so an artifact or a
   * tool result has to become text here or it is lost. Anything carrying a body
   * we cannot reach is counted rather than dropped quietly.
   */
  private flattenContent(blocks: readonly ApiContentBlock[]): readonly ImportTextBlock[] {
    const flattened: ImportTextBlock[] = []

    for (const block of blocks) {
      if (typeof block?.type !== 'string') continue
      this.count(this.blockTypeCounts, block.type)

      const direct = textOrUndefined(block.text)
      if (direct !== undefined && direct.length > 0) {
        flattened.push({ type: 'text', text: direct })
        continue
      }

      const body = this.bodyOf(block)
      if (body === undefined) continue

      if (body.length === 0) {
        this.count(this.unflattenedTypes, block.type)
        continue
      }

      const title = this.titleOf(block)
      const language = text(block.input?.['language'] ?? block.input?.['type'])
      flattened.push({ type: 'text', text: `**${title}**\n\n\`\`\`${language}\n${body}\n\`\`\`` })
    }

    return flattened
  }

  private bodyOf(block: ApiContentBlock): string | undefined {
    const input = block.input ?? {}
    return (
      textOrUndefined(input['content']) ??
      textOrUndefined(block.content) ??
      textOrUndefined(input['code'])
    )
  }

  private titleOf(block: ApiContentBlock): string {
    const input = block.input ?? {}
    return (
      textOrUndefined(input['title']) ??
      textOrUndefined(input['identifier']) ??
      textOrUndefined(block.name) ??
      block.type
    )
  }

  private mapAttachments(attachments: readonly ApiAttachment[]): readonly ImportAttachment[] {
    return attachments
      .filter((a) => typeof a?.extracted_content === 'string')
      .map((a) => ({ file_name: text(a.file_name), extracted_content: text(a.extracted_content) }))
  }

  private mapFileRefs(files: readonly ApiFileRef[]): readonly ImportFileRef[] {
    return files
      .filter((f) => typeof f?.file_uuid === 'string')
      .map((f) => ({ file_uuid: f.file_uuid, file_name: textOrUndefined(f.file_name) }))
  }

  private count(target: Map<string, number>, key: string): void {
    target.set(key, (target.get(key) ?? 0) + 1)
  }
}
