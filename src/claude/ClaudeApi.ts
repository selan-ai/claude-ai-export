/**
 * The claude.ai side of the export.
 *
 * Every method here runs inside a claude.ai page. That is not a style choice:
 * the session cookie is httpOnly, so only a same-origin request can carry it.
 * `credentials: 'include'` asks the browser to attach it — this code never sees
 * the value, and never stores or logs one.
 */

/** Raw shapes as claude.ai returns them. Undocumented, so treated as untrusted. */
export interface ApiOrganization {
  readonly uuid: string
  readonly name: string | null
}

export interface ApiConversationSummary {
  readonly uuid: string
  readonly name: string | null
  readonly updated_at: string | null
  readonly created_at: string | null
}

export interface ApiMessage {
  readonly uuid: string
  readonly parent_message_uuid: string | null
  readonly sender: string
  readonly text: string | null
  readonly content: readonly ApiContentBlock[] | null
  readonly created_at: string | null
  readonly attachments: readonly ApiAttachment[] | null
  readonly files: readonly ApiFileRef[] | null
}

export interface ApiContentBlock {
  readonly type: string
  readonly text: string | null
  readonly name: string | null
  readonly content: string | null
  readonly input: Record<string, unknown> | null
}

export interface ApiAttachment {
  readonly file_name: string | null
  readonly extracted_content: string | null
}

export interface ApiFileRef {
  readonly file_uuid: string
  readonly file_name: string | null
}

export interface ApiConversation extends ApiConversationSummary {
  readonly project_uuid: string | null
  readonly chat_messages: readonly ApiMessage[] | null
}

export interface ApiProject {
  readonly uuid: string
  readonly name: string | null
  readonly prompt_template: string | null
  readonly instructions: string | null
  readonly description: string | null
}

export interface ApiProjectDocument {
  readonly filename: string | null
  readonly file_name: string | null
  readonly title: string | null
  readonly content: string | null
  readonly text: string | null
}

export interface ApiProjectFile {
  readonly file_uuid: string | null
  readonly uuid: string | null
  readonly file_name: string | null
}

export class ClaudeApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`${path} responded ${status}`)
    this.name = 'ClaudeApiError'
  }
}

const conversationPageSize = 50
const maxRetries = 5

export class ClaudeApi {
  constructor(private readonly organizationUuid: string) {}

  /**
   * Which organization owns the data. An account can belong to several — a
   * personal one and a work one — and some refuse to be read at all, so the
   * caller must be able to tell "no chats" from "not allowed".
   */
  static async listOrganizations(): Promise<readonly ApiOrganization[]> {
    const bootstrap = await ClaudeApi.getJson<{
      account: { memberships: readonly { organization: ApiOrganization }[] } | null
    }>('/api/bootstrap')
    const memberships = bootstrap.account?.memberships ?? []
    return memberships.map((m) => m.organization).filter((o) => typeof o?.uuid === 'string')
  }

  /**
   * Can this organization's conversations be listed at all? Distinguishes an
   * empty organization from one this session may not read, so the caller never
   * silently exports nothing from the wrong place.
   */
  static async probeOrganization(
    uuid: string,
  ): Promise<{ readonly readable: boolean; readonly status: number; readonly count: number }> {
    const path = `/api/organizations/${uuid}/chat_conversations?limit=${conversationPageSize}&offset=0`
    const response = await fetch(path, { credentials: 'include', cache: 'no-store' }).catch(
      () => null,
    )
    if (response === null) return { readable: false, status: 0, count: 0 }
    if (!response.ok) return { readable: false, status: response.status, count: 0 }
    const body: unknown = await response.json().catch(() => null)
    return { readable: true, status: 200, count: Array.isArray(body) ? body.length : 0 }
  }

  /** Every conversation header, following pagination to the end. */
  async listConversations(
    onPage: (total: number) => void,
  ): Promise<readonly ApiConversationSummary[]> {
    const all: ApiConversationSummary[] = []
    for (let offset = 0; ; offset += conversationPageSize) {
      const page = await ClaudeApi.getJson<readonly ApiConversationSummary[]>(
        `${this.base}/chat_conversations?limit=${conversationPageSize}&offset=${offset}`,
      )
      all.push(...page)
      onPage(all.length)
      if (page.length < conversationPageSize) return all
    }
  }

  /**
   * One conversation with its full message tree.
   *
   * `rendering_mode=messages&render_all_tools=true` is what claude.ai itself
   * uses to *read* a conversation. `rendering_mode=raw` — which looks like the
   * obvious choice — is its mutation mode and returns no content blocks at all,
   * which silently drops every artifact and tool result.
   */
  async getConversation(uuid: string): Promise<ApiConversation> {
    return ClaudeApi.getJson<ApiConversation>(
      `${this.base}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`,
    )
  }

  async listProjects(): Promise<readonly ApiProject[]> {
    return ClaudeApi.getJson<readonly ApiProject[]>(`${this.base}/projects`)
  }

  async getProject(uuid: string): Promise<ApiProject | null> {
    return ClaudeApi.getJson<ApiProject>(`${this.base}/projects/${uuid}`).catch(() => null)
  }

  async listProjectDocuments(uuid: string): Promise<readonly ApiProjectDocument[]> {
    return ClaudeApi.getJson<readonly ApiProjectDocument[]>(
      `${this.base}/projects/${uuid}/docs`,
    ).catch(() => [])
  }

  async listProjectFiles(uuid: string): Promise<readonly ApiProjectFile[]> {
    return ClaudeApi.getJson<readonly ApiProjectFile[]>(
      `${this.base}/projects/${uuid}/files`,
    ).catch(() => [])
  }

  /**
   * Scheduled tasks. The endpoint sits under `cowork/`, which is why probing
   * `/scheduled_tasks`, `/routines` and `/schedules` all return 404.
   */
  async listScheduledTasks(): Promise<unknown> {
    return ClaudeApi.getJson<unknown>(`${this.base}/cowork/scheduled_tasks`).catch(() => null)
  }

  /**
   * File bytes. `/contents` serves any type; `/preview` and `/thumbnail` only
   * render images and PDFs, and 404 on things like .pptx and .zip — so they are
   * fallbacks, not the first choice.
   */
  async downloadFile(fileUuid: string): Promise<Uint8Array | null> {
    const candidates = [
      `${this.base}/files/${fileUuid}/contents`,
      `/api/${this.organizationUuid}/files/${fileUuid}/preview`,
      `/api/${this.organizationUuid}/files/${fileUuid}/thumbnail`,
    ]
    for (const path of candidates) {
      const bytes = await ClaudeApi.getBytes(path).catch(() => null)
      if (bytes !== null) return bytes
    }
    return null
  }

  private get base(): string {
    return `/api/organizations/${this.organizationUuid}`
  }

  private static async getJson<T>(path: string): Promise<T> {
    const response = await ClaudeApi.request(path)
    return (await response.json()) as T
  }

  private static async getBytes(path: string): Promise<Uint8Array> {
    const response = await ClaudeApi.request(path)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Retries only what is worth retrying: rate limits and server faults. */
  private static async request(path: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(path, { credentials: 'include', cache: 'no-store' })
      if (response.ok) return response

      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt >= maxRetries) throw new ClaudeApiError(path, response.status)

      const header = Number(response.headers.get('retry-after'))
      const seconds = Number.isFinite(header) && header > 0 ? header : 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    }
  }
}
