/*
 * Collects a claude.ai account's data and saves it as claude-export.zip.
 *
 * Injected into a logged-in claude.ai tab by popup.js. It has to run there:
 * the session cookie is httpOnly and only same-origin requests can use it.
 *
 * Every request goes to claude.ai and nowhere else. Cookies are never read,
 * logged or copied — `credentials: 'include'` lets the browser attach them
 * without this code ever seeing their value.
 */
(async () => {
  // The popup may be closed; background.js is always listening. Failures here
  // must never stop the collecting.
  const send = (m) => {
    try {
      chrome.runtime.sendMessage(m);
    } catch {
      /* receiver gone — keep going */
    }
  };
  const report = (text, done, total) => send({ type: 'export-progress', text, done, total });
  const CONCURRENCY = 4;
  const GAP_MS = 150;
  // Set this to a specific org uuid to skip auto-detection.
  const ORG_OVERRIDE = '';

  // ---------- fetch helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function req(path, as = 'json') {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(path, { credentials: 'include', cache: 'no-store' });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 5) throw new Error(`${path} -> ${res.status}`);
        const retry = Number(res.headers.get('retry-after')) || 2 ** attempt;
        report(`${res.status} on ${path}, retrying in ${retry}s`);
        await sleep(retry * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      return as === 'json' ? res.json() : new Uint8Array(await res.arrayBuffer());
    }
  }

  const soft = (p, fallback) => req(p).catch(() => fallback);

  async function pooled(items, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
        while (cursor < items.length) {
          const i = cursor++;
          out[i] = await worker(items[i], i);
          await sleep(GAP_MS);
        }
      }),
    );
    return out;
  }

  // ---------- schema coercion ----------
  // The importer validates with zod. A single bad field drops the whole
  // enclosing array (message list, attachment list), so normalise everything
  // here rather than passing API objects through raw.
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const strOrNull = (v) => (typeof v === 'string' ? v : null);

  const skipped = [];
  const blockTypes = {};
  const unflattened = {};

  function normMessage(m) {
    // The importer only keeps blocks of type 'text' and drops everything else,
    // so anything carrying content (artifacts, tool output) has to be flattened
    // into text here or it is lost on import.
    const content = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b || typeof b.type !== 'string') continue;
      blockTypes[b.type] = (blockTypes[b.type] ?? 0) + 1;
      if (typeof b.text === 'string' && b.text.length > 0) {
        content.push({ type: 'text', text: b.text });
        continue;
      }
      const body = b.input?.content ?? b.content ?? b.input?.code;
      if (typeof body === 'string' && body.length > 0) {
        const title = b.input?.title ?? b.input?.identifier ?? b.name ?? b.type;
        const lang = b.input?.language ?? b.input?.type ?? '';
        content.push({ type: 'text', text: `**${title}**\n\n\`\`\`${lang}\n${body}\n\`\`\`` });
      } else if (body !== undefined) {
        unflattened[b.type] = (unflattened[b.type] ?? 0) + 1;
      }
    }
    const attachments = (Array.isArray(m.attachments) ? m.attachments : [])
      .filter((a) => a && typeof a.extracted_content === 'string')
      .map((a) => ({ file_name: str(a.file_name), extracted_content: a.extracted_content }));
    const files = (Array.isArray(m.files) ? m.files : [])
      .filter((f) => f && typeof f.file_uuid === 'string')
      .map((f) => ({ file_uuid: f.file_uuid, file_name: str(f.file_name, undefined) }));
    return {
      uuid: str(m.uuid),
      parent_message_uuid: strOrNull(m.parent_message_uuid),
      sender: str(m.sender, 'assistant'),
      text: str(m.text),
      content,
      created_at: str(m.created_at),
      attachments,
      files,
    };
  }

  function normConversation(c) {
    return {
      uuid: str(c.uuid),
      name: str(c.name),
      created_at: str(c.created_at, undefined),
      updated_at: str(c.updated_at, undefined),
      project_uuid: strOrNull(c.project_uuid),
      chat_messages: (Array.isArray(c.chat_messages) ? c.chat_messages : []).map(normMessage),
    };
  }

  // ---------- collect ----------
  report('bootstrap');
  const boot = await req('/api/bootstrap');
  const me = boot.account;
  if (!me || !Array.isArray(me.memberships) || me.memberships.length === 0)
    throw new Error('no organizations on this account — are you logged in to claude.ai?');

  // An account can belong to several orgs (personal + work). Picking the wrong
  // one exports an empty archive, so probe each and take the one with chats.
  const orgs = me.memberships.map((m) => m.organization).filter((o) => o && o.uuid);
  let ORG;
  if (ORG_OVERRIDE) {
    ORG = ORG_OVERRIDE;
  } else if (orgs.length === 1) {
    ORG = orgs[0].uuid;
  } else {
    report(`${orgs.length} organizations, probing each`);
    // Probe with a raw fetch so an HTTP error is distinguishable from an empty
    // org. Swallowing the status here would silently pick an unreadable org.
    const probes = await Promise.all(
      orgs.map(async (o) => {
        const res = await fetch(`/api/organizations/${o.uuid}/chat_conversations?limit=50&offset=0`, {
          credentials: 'include',
          cache: 'no-store',
        }).catch(() => null);
        if (!res || !res.ok) return { o, status: res ? res.status : 0, count: -1 };
        const body = await res.json().catch(() => null);
        return { o, status: 200, count: Array.isArray(body) ? body.length : 0 };
      }),
    );
    for (const p of probes)
      report(
        `  ${p.o.name ?? '(unnamed)'} -> ${
          p.status === 200 ? `${p.count}+ chats` : `HTTP ${p.status || 'network error'}`
        }`,
      );
    const usable = probes.filter((p) => p.status === 200 && p.count > 0);
    if (usable.length === 0)
      throw new Error(
        'no organization returned conversations. Pick one from the list above and set ORG_OVERRIDE at the top of the script.',
      );
    usable.sort((a, b) => b.count - a.count);
    ORG = usable[0].o.uuid;
  }
  const chosen = orgs.find((o) => o.uuid === ORG);
  report(`using org: ${chosen?.name ?? '(unknown name)'} ${ORG}`);
  const api = `/api/organizations/${ORG}`;

  const all = [];
  for (let off = 0; ; off += 50) {
    const page = await req(`${api}/chat_conversations?limit=50&offset=${off}`);
    all.push(...page);
    report(`listed ${all.length} conversations`);
    if (page.length < 50) break;
  }

  // Optional date window, set by the popup. Filtered on last activity, so an
  // old chat you replied to yesterday still comes along.
  const days = Number(globalThis.__CLAUDE_EXPORT_DAYS) || 0;
  let index = all;
  if (days > 0) {
    const cutoff = Date.now() - days * 86400000;
    index = all.filter((c) => {
      const t = Date.parse(c.updated_at ?? c.created_at ?? '');
      return Number.isNaN(t) ? true : t >= cutoff;
    });
    report(`last ${days} days: ${index.length} of ${all.length} conversations`);
  }

  report(`reading ${index.length} chats`, 0, index.length);
  let done = 0;
  const trees = await pooled(index, async (c) => {
    // rendering_mode=raw is what the web app uses for PUT/mutations; it returns
    // no content blocks. Reading a tree uses messages + render_all_tools, which
    // is where artifacts and tool output actually live.
    const full = await soft(
      `${api}/chat_conversations/${c.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`,
      null,
    );
    done += 1;
    report(`reading chats ${done}/${index.length}`, done, index.length);
    if (!full) {
      skipped.push({ kind: 'conversation', uuid: c.uuid, name: c.name, reason: 'tree fetch failed' });
      return null;
    }
    return full;
  });
  const conversations = trees.filter(Boolean).map(normConversation);

  report('projects');
  const projectIndex = await req(`${api}/projects`);
  const projects = await pooled(projectIndex, async (p) => {
    const [detail, docs, files] = await Promise.all([
      soft(`${api}/projects/${p.uuid}`, {}),
      soft(`${api}/projects/${p.uuid}/docs`, []),
      soft(`${api}/projects/${p.uuid}/files`, []),
    ]);
    const src = { ...p, ...detail };
    // The importer reads project instructions from `prompt_template` only.
    const instructions =
      src.prompt_template ?? src.instructions ?? src.custom_instructions ?? src.description;
    return {
      uuid: str(src.uuid),
      name: str(src.name),
      prompt_template: typeof instructions === 'string' ? instructions : undefined,
      docs: (Array.isArray(docs) ? docs : [])
        .map((d) => ({
          filename: str(d.filename ?? d.file_name ?? d.title, undefined),
          content: str(d.content ?? d.text),
        }))
        .filter((d) => d.content.length > 0),
      files: (Array.isArray(files) ? files : [])
        .filter((f) => f && (f.file_uuid || f.uuid))
        .map((f) => ({ file_uuid: str(f.file_uuid ?? f.uuid), file_name: str(f.file_name, undefined) })),
    };
  });

  // Projects whose slug is not [A-Za-z0-9_-] are silently dropped by the
  // importer. Warn here instead of losing them quietly.
  const slugOk = /^[a-zA-Z0-9_-]+$/;
  for (const p of projects) {
    const slug = `${p.name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}-${p.uuid}`;
    if (!slugOk.test(slug) || slug.length > 200) {
      skipped.push({ kind: 'project', uuid: p.uuid, name: p.name, reason: 'name will not slugify' });
    }
  }

  report('scheduled tasks');
  const schedulesRaw = await soft(`${api}/cowork/scheduled_tasks`, null);
  const schedules = schedulesRaw ?? { unavailable: true };

  // ---------- binary assets ----------
  const wanted = new Map(); // file_uuid -> file_name
  for (const c of conversations)
    for (const m of c.chat_messages) for (const f of m.files) wanted.set(f.file_uuid, f.file_name);
  for (const p of projects) for (const f of p.files) wanted.set(f.file_uuid, f.file_name);

  report(`downloading ${wanted.size} binary assets`);
  const assets = await pooled([...wanted.keys()], async (uuid) => {
    // /contents serves any file type; /preview and /thumbnail only render
    // images and PDFs, so they 404 on things like .pptx and .zip.
    for (const url of [
      `${api}/files/${uuid}/contents`,
      `/api/${ORG}/files/${uuid}/preview`,
      `/api/${ORG}/files/${uuid}/thumbnail`,
    ]) {
      try {
        return { uuid, data: await req(url, 'bytes') };
      } catch {
        /* try next */
      }
    }
    skipped.push({ kind: 'file', uuid, name: wanted.get(uuid), reason: 'download failed' });
    return null;
  });

  // ---------- zip (store-only, no dependency) ----------
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (u8) => {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  function buildZip(entries) {
    if (entries.length > 0xffff) throw new Error('too many zip entries for a non-ZIP64 archive');
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 0x0800, true); // UTF-8 names
      h.setUint16(8, 0, true); // stored
      h.setUint32(14, crc, true);
      h.setUint32(18, e.data.length, true);
      h.setUint32(22, e.data.length, true);
      h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, e.data);
      central.push({ name, crc, size: e.data.length, offset });
      offset += 30 + name.length + e.data.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, 0, true);
      h.setUint32(16, c.crc, true);
      h.setUint32(20, c.size, true);
      h.setUint32(24, c.size, true);
      h.setUint16(28, c.name.length, true);
      h.setUint32(42, c.offset, true);
      parts.push(new Uint8Array(h.buffer), c.name);
      offset += 46 + c.name.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    parts.push(new Uint8Array(eocd.buffer));
    return new Blob(parts, { type: 'application/zip' });
  }

  const enc = new TextEncoder();
  const json = (name, value) => ({ name, data: enc.encode(JSON.stringify(value)) });

  const entries = [
    json('conversations.json', conversations),
    json('projects.json', projects),
    json('users.json', [{ uuid: me.uuid, full_name: me.full_name, email_address: me.email_address }]),
    // Not read by the importer; consumed by import-schedules.md.
    json('schedules.json', schedules),
    json('skipped.json', skipped),
    json('blocktypes.json', { blockTypes, unflattened }),
    // No manifest.json on purpose: when absent the importer derives one from
    // the data, which can never trip IMPORT_MANIFEST_MISMATCH.
    ...assets.filter(Boolean).map((a) => ({ name: `files/${a.uuid}`, data: a.data })),
  ];

  const blob = buildZip(entries);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'claude-export.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  const messages = conversations.reduce((n, c) => n + c.chat_messages.length, 0);
  const summary = {
    conversations: conversations.length,
    messages,
    projects: projects.length,
    docs: projects.reduce((n, p) => n + p.docs.length, 0),
    assets: assets.filter(Boolean).length,
    schedules: Array.isArray(schedules) ? schedules.length : 'see schedules.json',
    rangeDays: days || 'all',
    skipped: skipped.length,
    blockTypes,
    zipBytes: blob.size,
  };
  send({ type: 'export-done', summary });
  if (skipped.length) report(`skipped ${skipped.length} item(s)`);
  if (blob.size > 1024 ** 3) report('WARNING: over the 1 GiB import limit — split required');
  return summary;
})().catch((e) => {
  try {
    chrome.runtime.sendMessage({ type: 'export-error', error: String(e?.message ?? e) });
  } catch {
    /* nothing listening */
  }
});
