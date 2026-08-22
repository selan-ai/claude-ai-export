// Built from src/ by scripts/build.mjs — do not edit. Run `npm run verify`.
"use strict";
(() => {
  // src/domain.ts
  var ExportRange = {
    lastThirtyDays: 30,
    lastNinetyDays: 90,
    everything: 0
  };
  var exportRangeValues = Object.values(ExportRange);
  function parseExportRange(raw) {
    if (raw.trim() === "") return ExportRange.lastThirtyDays;
    const days = Number(raw);
    return exportRangeValues.includes(days) ? days : ExportRange.lastThirtyDays;
  }
  var ExportPhase = {
    idle: "idle",
    awaitingSignIn: "awaitingSignIn",
    running: "running",
    done: "done",
    failed: "failed"
  };
  var idleState = {
    phase: ExportPhase.idle,
    label: "",
    percent: 0,
    summary: null,
    error: null
  };
  var MessageKind = {
    start: "start",
    requestState: "requestState",
    progress: "progress",
    awaitingSignIn: "awaitingSignIn",
    finished: "finished",
    failed: "failed"
  };
  var ProgressStop = {
    listing: 2,
    chatsStart: 5,
    chatsEnd: 70,
    projects: 72,
    scheduledTasks: 76,
    assetsStart: 78,
    assetsEnd: 95,
    buildingArchive: 96,
    saving: 98,
    complete: 100
  };
  var maxInFlightPercent = 98;

  // src/archive/ZipArchive.ts
  var localHeaderSignature = 67324752;
  var centralHeaderSignature = 33639248;
  var endOfDirectorySignature = 101010256;
  var localHeaderBytes = 30;
  var centralHeaderBytes = 46;
  var endOfDirectoryBytes = 22;
  var versionNeeded = 20;
  var utf8NameFlag = 2048;
  var storedMethod = 0;
  var maxEntries = 65535;
  var crcTable = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) === 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let value = 4294967295;
    for (let index = 0; index < bytes.length; index++) {
      const nextByte = bytes[index] ?? 0;
      value = (crcTable[(value ^ nextByte) & 255] ?? 0) ^ value >>> 8;
    }
    return (value ^ 4294967295) >>> 0;
  }
  var ZipArchive = class {
    parts = [];
    directory = [];
    offset = 0;
    encoder = new TextEncoder();
    get entryCount() {
      return this.directory.length;
    }
    addText(path, contents) {
      this.addBytes(path, this.encoder.encode(contents));
    }
    addJson(path, value) {
      this.addText(path, JSON.stringify(value));
    }
    addBytes(path, data) {
      if (this.directory.length >= maxEntries) {
        throw new Error("too many entries for a non-ZIP64 archive");
      }
      const name = this.encoder.encode(path);
      const crc = crc32(data);
      const header = new DataView(new ArrayBuffer(localHeaderBytes));
      header.setUint32(0, localHeaderSignature, true);
      header.setUint16(4, versionNeeded, true);
      header.setUint16(6, utf8NameFlag, true);
      header.setUint16(8, storedMethod, true);
      header.setUint32(14, crc, true);
      header.setUint32(18, data.length, true);
      header.setUint32(22, data.length, true);
      header.setUint16(26, name.length, true);
      this.parts.push(new Uint8Array(header.buffer), name, data);
      this.directory.push({ name, crc, size: data.length, offset: this.offset });
      this.offset += localHeaderBytes + name.length + data.length;
    }
    toBlob() {
      const directoryStart = this.offset;
      let cursor = this.offset;
      for (const entry of this.directory) {
        const header = new DataView(new ArrayBuffer(centralHeaderBytes));
        header.setUint32(0, centralHeaderSignature, true);
        header.setUint16(4, versionNeeded, true);
        header.setUint16(6, versionNeeded, true);
        header.setUint16(8, utf8NameFlag, true);
        header.setUint16(10, storedMethod, true);
        header.setUint32(16, entry.crc, true);
        header.setUint32(20, entry.size, true);
        header.setUint32(24, entry.size, true);
        header.setUint16(28, entry.name.length, true);
        header.setUint32(42, entry.offset, true);
        this.parts.push(new Uint8Array(header.buffer), entry.name);
        cursor += centralHeaderBytes + entry.name.length;
      }
      const end = new DataView(new ArrayBuffer(endOfDirectoryBytes));
      end.setUint32(0, endOfDirectorySignature, true);
      end.setUint16(8, this.directory.length, true);
      end.setUint16(10, this.directory.length, true);
      end.setUint32(12, cursor - directoryStart, true);
      end.setUint32(16, directoryStart, true);
      this.parts.push(new Uint8Array(end.buffer));
      return new Blob(this.parts, { type: "application/zip" });
    }
  };

  // src/claude/ClaudeApi.ts
  var ClaudeApiError = class extends Error {
    constructor(path, status) {
      super(`${path} responded ${status}`);
      this.path = path;
      this.status = status;
      this.name = "ClaudeApiError";
    }
  };
  var conversationPageSize = 50;
  var maxRetries = 5;
  var ClaudeApi = class _ClaudeApi {
    constructor(organizationUuid) {
      this.organizationUuid = organizationUuid;
    }
    /**
     * Which organization owns the data. An account can belong to several — a
     * personal one and a work one — and some refuse to be read at all, so the
     * caller must be able to tell "no chats" from "not allowed".
     */
    static async listOrganizations() {
      const bootstrap = await _ClaudeApi.getJson("/api/bootstrap");
      const memberships = bootstrap.account?.memberships ?? [];
      return memberships.map((m) => m.organization).filter((o) => typeof o?.uuid === "string");
    }
    /**
     * Can this organization's conversations be listed at all? Distinguishes an
     * empty organization from one this session may not read, so the caller never
     * silently exports nothing from the wrong place.
     */
    static async probeOrganization(uuid) {
      const path = `/api/organizations/${uuid}/chat_conversations?limit=${conversationPageSize}&offset=0`;
      const response = await fetch(path, { credentials: "include", cache: "no-store" }).catch(
        () => null
      );
      if (response === null) return { readable: false, status: 0, count: 0 };
      if (!response.ok) return { readable: false, status: response.status, count: 0 };
      const body = await response.json().catch(() => null);
      return { readable: true, status: 200, count: Array.isArray(body) ? body.length : 0 };
    }
    /** Every conversation header, following pagination to the end. */
    async listConversations(onPage) {
      const all = [];
      for (let offset = 0; ; offset += conversationPageSize) {
        const page = await _ClaudeApi.getJson(
          `${this.base}/chat_conversations?limit=${conversationPageSize}&offset=${offset}`
        );
        all.push(...page);
        onPage(all.length);
        if (page.length < conversationPageSize) return all;
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
    async getConversation(uuid) {
      return _ClaudeApi.getJson(
        `${this.base}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
      );
    }
    async listProjects() {
      return _ClaudeApi.getJson(`${this.base}/projects`);
    }
    async getProject(uuid) {
      return _ClaudeApi.getJson(`${this.base}/projects/${uuid}`).catch(() => null);
    }
    async listProjectDocuments(uuid) {
      return _ClaudeApi.getJson(
        `${this.base}/projects/${uuid}/docs`
      ).catch(() => []);
    }
    async listProjectFiles(uuid) {
      return _ClaudeApi.getJson(
        `${this.base}/projects/${uuid}/files`
      ).catch(() => []);
    }
    /**
     * Scheduled tasks. The endpoint sits under `cowork/`, which is why probing
     * `/scheduled_tasks`, `/routines` and `/schedules` all return 404.
     */
    async listScheduledTasks() {
      return _ClaudeApi.getJson(`${this.base}/cowork/scheduled_tasks`).catch(() => null);
    }
    /**
     * File bytes. `/contents` serves any type; `/preview` and `/thumbnail` only
     * render images and PDFs, and 404 on things like .pptx and .zip — so they are
     * fallbacks, not the first choice.
     */
    async downloadFile(fileUuid) {
      const candidates = [
        `${this.base}/files/${fileUuid}/contents`,
        `/api/${this.organizationUuid}/files/${fileUuid}/preview`,
        `/api/${this.organizationUuid}/files/${fileUuid}/thumbnail`
      ];
      for (const path of candidates) {
        const bytes = await _ClaudeApi.getBytes(path).catch(() => null);
        if (bytes !== null) return bytes;
      }
      return null;
    }
    get base() {
      return `/api/organizations/${this.organizationUuid}`;
    }
    static async getJson(path) {
      const response = await _ClaudeApi.request(path);
      return await response.json();
    }
    static async getBytes(path) {
      const response = await _ClaudeApi.request(path);
      return new Uint8Array(await response.arrayBuffer());
    }
    /** Retries only what is worth retrying: rate limits and server faults. */
    static async request(path) {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(path, { credentials: "include", cache: "no-store" });
        if (response.ok) return response;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= maxRetries) throw new ClaudeApiError(path, response.status);
        const header = Number(response.headers.get("retry-after"));
        const seconds = Number.isFinite(header) && header > 0 ? header : 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, seconds * 1e3));
      }
    }
  };

  // src/claude/ExportMapper.ts
  var defaultSender = "assistant";
  function text(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }
  function textOrUndefined(value) {
    return typeof value === "string" ? value : void 0;
  }
  function textOrNull(value) {
    return typeof value === "string" ? value : null;
  }
  var ExportMapper = class {
    blockTypeCounts = /* @__PURE__ */ new Map();
    unflattenedTypes = /* @__PURE__ */ new Map();
    /** Which content block types were seen, and which carried content we could not reach. */
    get diagnostics() {
      return {
        seen: Object.fromEntries(this.blockTypeCounts),
        unflattened: Object.fromEntries(this.unflattenedTypes)
      };
    }
    mapConversation(source) {
      return {
        uuid: text(source.uuid),
        name: text(source.name),
        created_at: textOrUndefined(source.created_at),
        updated_at: textOrUndefined(source.updated_at),
        project_uuid: textOrNull(source.project_uuid),
        chat_messages: (source.chat_messages ?? []).map((m) => this.mapMessage(m))
      };
    }
    mapProject(source, documents, files) {
      const instructions = textOrUndefined(source.prompt_template) ?? textOrUndefined(source.instructions) ?? textOrUndefined(source.description);
      return {
        uuid: text(source.uuid),
        name: text(source.name),
        prompt_template: instructions,
        docs: documents.map((d) => ({
          filename: textOrUndefined(d.filename ?? d.file_name ?? d.title),
          content: text(d.content ?? d.text)
        })).filter((d) => d.content.length > 0),
        files: files.map((f) => ({
          file_uuid: text(f.file_uuid ?? f.uuid),
          file_name: textOrUndefined(f.file_name)
        })).filter((f) => f.file_uuid.length > 0)
      };
    }
    mapMessage(source) {
      return {
        uuid: text(source.uuid),
        parent_message_uuid: textOrNull(source.parent_message_uuid),
        sender: text(source.sender, defaultSender),
        text: text(source.text),
        content: this.flattenContent(source.content ?? []),
        created_at: text(source.created_at),
        attachments: this.mapAttachments(source.attachments ?? []),
        files: this.mapFileRefs(source.files ?? [])
      };
    }
    /**
     * The importer keeps `text` blocks and discards the rest, so an artifact or a
     * tool result has to become text here or it is lost. Anything carrying a body
     * we cannot reach is counted rather than dropped quietly.
     */
    flattenContent(blocks) {
      const flattened = [];
      for (const block of blocks) {
        if (typeof block?.type !== "string") continue;
        this.count(this.blockTypeCounts, block.type);
        const direct = textOrUndefined(block.text);
        if (direct !== void 0 && direct.length > 0) {
          flattened.push({ type: "text", text: direct });
          continue;
        }
        const body = this.bodyOf(block);
        if (body === void 0) continue;
        if (body.length === 0) {
          this.count(this.unflattenedTypes, block.type);
          continue;
        }
        const title = this.titleOf(block);
        const language = text(block.input?.["language"] ?? block.input?.["type"]);
        flattened.push({ type: "text", text: `**${title}**

\`\`\`${language}
${body}
\`\`\`` });
      }
      return flattened;
    }
    bodyOf(block) {
      const input = block.input ?? {};
      return textOrUndefined(input["content"]) ?? textOrUndefined(block.content) ?? textOrUndefined(input["code"]);
    }
    titleOf(block) {
      const input = block.input ?? {};
      return textOrUndefined(input["title"]) ?? textOrUndefined(input["identifier"]) ?? textOrUndefined(block.name) ?? block.type;
    }
    mapAttachments(attachments) {
      return attachments.filter((a) => typeof a?.extracted_content === "string").map((a) => ({ file_name: text(a.file_name), extracted_content: text(a.extracted_content) }));
    }
    mapFileRefs(files) {
      return files.filter((f) => typeof f?.file_uuid === "string").map((f) => ({ file_uuid: f.file_uuid, file_name: textOrUndefined(f.file_name) }));
    }
    count(target, key) {
      target.set(key, (target.get(key) ?? 0) + 1);
    }
  };

  // src/export/ExportSession.ts
  var requestGapMs = 150;
  var concurrency = 4;
  var millisecondsPerDay = 864e5;
  var archiveName = "claude-export.zip";
  var maxArchiveBytes = 1024 ** 3;
  function interpolate(from, to, done, total) {
    if (total <= 0) return to;
    return from + (to - from) * done / total;
  }
  var ExportSession = class {
    constructor(options) {
      this.options = options;
    }
    mapper = new ExportMapper();
    skipped = [];
    available = 0;
    async run() {
      const api = new ClaudeApi(await this.resolveOrganization());
      const conversations = await this.collectConversations(api);
      const projects = await this.collectProjects(api);
      this.options.progress.report("Reading scheduled tasks", ProgressStop.scheduledTasks);
      const scheduledTasks = await api.listScheduledTasks();
      const assets = await this.collectAssets(api, conversations, projects);
      return this.buildArchive(conversations, projects, scheduledTasks, assets);
    }
    /**
     * An account can belong to several organizations, and a session is not
     * always allowed to read all of them. Probing tells "empty" apart from
     * "forbidden", so a 403 on one never results in silently exporting nothing.
     */
    async resolveOrganization() {
      const organizations = await ClaudeApi.listOrganizations();
      if (organizations.length === 0) {
        throw new Error("No organizations on this account. Are you signed in to claude.ai?");
      }
      const only = organizations[0];
      if (organizations.length === 1 && only !== void 0) return only.uuid;
      const probes = await Promise.all(
        organizations.map(async (organization) => ({
          organization,
          ...await ClaudeApi.probeOrganization(organization.uuid)
        }))
      );
      const usable = probes.filter((p) => p.readable && p.count > 0).sort((a, b) => b.count - a.count);
      const best = usable[0];
      if (best === void 0) {
        throw new Error("None of your organizations returned any conversations.");
      }
      return best.organization.uuid;
    }
    async collectConversations(api) {
      const headers = await api.listConversations(
        (total) => this.options.progress.report(`Listing conversations — ${total} so far`, ProgressStop.listing)
      );
      this.available = headers.length;
      const selected = this.withinRange(headers);
      const noun = selected.length === 1 ? "chat" : "chats";
      this.options.progress.report(`Reading ${selected.length} ${noun}`, ProgressStop.chatsStart);
      let done = 0;
      const trees = await this.pooled(selected, async (header) => {
        const conversation = await api.getConversation(header.uuid).catch(() => null);
        done += 1;
        this.options.progress.report(
          `Reading chats — ${done} of ${selected.length}`,
          interpolate(ProgressStop.chatsStart, ProgressStop.chatsEnd, done, selected.length)
        );
        if (conversation === null) {
          this.skip("conversation", header.uuid, header.name ?? "", "could not be fetched");
          return null;
        }
        return this.mapper.mapConversation(conversation);
      });
      return trees.filter((c) => c !== null);
    }
    /** Filtered on last activity, so an old thread replied to yesterday still comes along. */
    withinRange(headers) {
      if (this.options.rangeDays === ExportRange.everything) return headers;
      const cutoff = Date.now() - this.options.rangeDays * millisecondsPerDay;
      return headers.filter((header) => {
        const stamp = Date.parse(header.updated_at ?? header.created_at ?? "");
        return Number.isNaN(stamp) ? true : stamp >= cutoff;
      });
    }
    async collectProjects(api) {
      this.options.progress.report("Reading projects", ProgressStop.projects);
      const summaries = await api.listProjects();
      return this.pooled(summaries, async (summary) => {
        const [detail, documents, files] = await Promise.all([
          api.getProject(summary.uuid),
          api.listProjectDocuments(summary.uuid),
          api.listProjectFiles(summary.uuid)
        ]);
        return this.mapper.mapProject({ ...summary, ...detail ?? {} }, documents, files);
      });
    }
    async collectAssets(api, conversations, projects) {
      const wanted = /* @__PURE__ */ new Map();
      for (const conversation of conversations) {
        for (const message of conversation.chat_messages) {
          for (const file of message.files) wanted.set(file.file_uuid, file.file_name ?? "");
        }
      }
      for (const project of projects) {
        for (const file of project.files) wanted.set(file.file_uuid, file.file_name ?? "");
      }
      const total = wanted.size;
      this.options.progress.report(
        `Downloading ${total} file${total === 1 ? "" : "s"}`,
        ProgressStop.assetsStart
      );
      const downloaded = /* @__PURE__ */ new Map();
      let done = 0;
      await this.pooled([...wanted.keys()], async (uuid) => {
        const bytes = await api.downloadFile(uuid);
        done += 1;
        this.options.progress.report(
          `Downloading files — ${done} of ${total}`,
          interpolate(ProgressStop.assetsStart, ProgressStop.assetsEnd, done, total)
        );
        if (bytes === null) this.skip("file", uuid, wanted.get(uuid) ?? "", "download failed");
        else downloaded.set(uuid, bytes);
        return null;
      });
      return downloaded;
    }
    buildArchive(conversations, projects, scheduledTasks, assets) {
      this.options.progress.report("Building the zip", ProgressStop.buildingArchive);
      const archive = new ZipArchive();
      archive.addJson("conversations.json", conversations);
      archive.addJson("projects.json", projects);
      archive.addJson("users.json", [{ uuid: crypto.randomUUID() }]);
      archive.addJson("schedules.json", scheduledTasks ?? { unavailable: true });
      archive.addJson("skipped.json", this.skipped);
      archive.addJson("blocktypes.json", this.mapper.diagnostics);
      for (const [uuid, bytes] of assets) archive.addBytes(`files/${uuid}`, bytes);
      this.options.progress.report("Saving to Downloads", ProgressStop.saving);
      const blob = archive.toBlob();
      if (blob.size > maxArchiveBytes) {
        throw new Error("Export exceeds the 1 GiB import limit. Choose a shorter date range.");
      }
      this.options.archive.deliver(archiveName, blob);
      const tasks = Array.isArray(scheduledTasks) ? scheduledTasks.length : Array.isArray(scheduledTasks?.data) ? scheduledTasks.data.length : 0;
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
        zipBytes: blob.size
      };
    }
    skip(kind, uuid, name, reason) {
      this.skipped.push({ kind, uuid, name, reason });
    }
    /** Bounded concurrency with a gap between requests, to stay under rate limits. */
    async pooled(items, worker) {
      const results = new Array(items.length);
      let cursor = 0;
      const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
          const index = cursor++;
          const item = items[index];
          if (item === void 0) continue;
          results[index] = await worker(item);
          await new Promise((resolve) => setTimeout(resolve, requestGapMs));
        }
      });
      await Promise.all(lanes);
      return results;
    }
  };

  // src/entry/collector.ts
  function post(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch {
    }
  }
  var MessageProgress = class {
    report(label, percent) {
      post({
        kind: MessageKind.progress,
        label,
        percent: Math.min(maxInFlightPercent, Math.round(percent))
      });
    }
  };
  var DownloadSink = class {
    deliver(fileName, blob) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1e4);
    }
  };
  async function main() {
    const session = new ExportSession({
      rangeDays: parseExportRange(globalThis.__claudeExportRangeDays ?? ""),
      progress: new MessageProgress(),
      archive: new DownloadSink()
    });
    try {
      post({ kind: MessageKind.finished, summary: await session.run() });
    } catch (error) {
      post({
        kind: MessageKind.failed,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  void main();
})();
