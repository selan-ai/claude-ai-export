# Claude AI Export

Export your **claude.ai** chats, projects, attachments and scheduled tasks to a
zip on your own computer — and import them into **Claude Desktop**.

Unofficial. Not made by, affiliated with, or endorsed by Anthropic.

Built for people whose workspace admin has not enabled member data export, and
for anyone who wants a local copy of their own conversations.

---

**[Step-by-step guide with screenshots →](docs/IMPORT_EXPORT.md)**

## 1. Export

**Chrome Web Store** — pending review. Until it clears, load it directly:

1. Download or clone this repository
2. `chrome://extensions` → turn on **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Click the icon in the toolbar

It opens claude.ai for you if it needs to, and waits if you are not signed in.
A large history takes a few minutes; the page shows progress and you can close
the tab — the export keeps running.

`claude-export.zip` lands in your Downloads folder. Roughly 25 MB for 350
conversations.

> **Choose "Everything" if you are moving accounts.** The default is the last 30
> days, and on an account whose history is older that produces a small archive
> which looks perfectly successful — 600 KB where the full export is 25 MB. The
> page tells you how many of your chats the window actually covered; read that
> line before importing.

Chrome, Edge, Brave and Arc. Firefox needs a manifest variant; Safari needs an
Xcode wrapper.

## 2. Import

Claude Desktop has a built-in importer when your organisation has it storing
conversations locally. It is the supported path and this project does not
replace it.

**Settings → Import & export → `Import…`**

The wizard has three steps:

1. **Chats** — press **`Choose file…`** and pick your `claude-export.zip`.
   Ignore *Sign in to claude.ai…* beside it: that fetches Anthropic's own member
   export, which is the thing your admin has probably not enabled — it is why
   this project exists.
2. **Cowork & Code** — local sessions from an earlier Claude install. **Skip
   this step** unless you have some.
3. **Review** — it shows a count. Check it matches your export, then **Import**.

Chats appear in the sidebar and projects become Spaces. The first message in an
imported chat asks **Resume imported session? → Trust and resume**; that is
expected, once per chat.

> Each import is a one-time copy. Re-running it **never creates duplicates** —
> but it also **never refreshes a chat already imported**. Existing sessions are
> skipped, not updated, so fixing a bad export means removing the old import
> first.

### 3. Scheduled tasks

These cannot go through that wizard, so they are a separate one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/selan-ai/claude-ai-export/main/scripts/import.sh | bash
```

It finds your newest export, writes the tasks, and then opens Claude Desktop
with the archive already selected — so you can do step 2 above without hunting
through Downloads. Only `bash`, `jq`, `unzip` and `date`, all stock on macOS 15
and later. It backs up anything it replaces and tells you the undo command.

**Why they need their own step:** the importer reads five things out of the
archive — `conversations.json`, `projects.json`, `users.json`, `manifest.json`
and `files/` — and nothing else. There is no field for a schedule in that
schema, so no archive could carry one. Desktop's own tasks are not server data
either: they are a local JSON record plus a skill file on disk. The script
writes those, converting each cron expression from UTC to your local time —
claude.ai stores them in UTC and Desktop runs them locally, so copying one
across unchanged fires it at the wrong hour.

### What lands where

| | |
|---|---|
| Chats | sidebar, full message trees including edited and regenerated branches |
| Projects | Spaces, with instructions and knowledge documents |
| Chat ↔ project grouping | preserved |
| Attachments | text inline, images and files restored |
| Scheduled tasks | written by `import.sh`, not the wizard |
| Memory | not exportable from claude.ai at all |

---

## It cannot send your data anywhere

You do not have to take that on trust. Read `src/static/manifest.json`:

```json
"permissions": ["scripting"],
"host_permissions": ["https://claude.ai/*"],
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'none'"
}
```

`claude.ai` is the only host it may contact. There is no analytics endpoint, no
remote configuration, and the policy forbids loading remote code. Chrome
enforces all three. Those lines are checkable in thirty seconds, without reading
any logic.

It has **no runtime dependencies** — not even a zip library; that is written out
longhand so there is nothing extra to audit.

It never reads or stores your claude.ai session. `credentials: 'include'` asks
the browser to attach your existing sign-in, so the browser holds the credential
and this code never sees its value. That is also why the export runs in a
browser at all: the cookie is `httpOnly`, so only a page on claude.ai can use
it, and anything else would have to extract cookies out of your browser.

Full policy: [PRIVACY.md](PRIVACY.md).

### The published code is the code that runs

The source is TypeScript, so there is a build. The output is committed, never
minified, and reproducible:

```bash
npm ci && npm run verify
```

That rebuilds everything in `extension/` from `src/` and fails if a single byte
differs from what is committed.

---

## Development

```bash
npm ci
npm run check     # typecheck, lint, tests, reproducible-build check
npm run build     # rebuild extension/ from src/
```

TypeScript 7, Biome, Node's built-in test runner. No test framework, no bundler
config beyond one esbuild call.

```
src/                 everything authored
  domain.ts            vocabulary shared across process boundaries
  claude/              the claude.ai API, and mapping it to the import schema
  archive/             store-only zip writer
  export/              one export, start to finish
  entry/               collector (in-page), background worker, page
  static/              manifest, HTML, CSS, icons
extension/           ENTIRELY GENERATED — never edit; wiped on every build
scripts/import.sh    the import half
```

`extension/` is committed even though it is generated, for two reasons: "Load
unpacked" has to work straight from a clone, and `npm run verify` needs
something to compare a fresh build against.

[CLAUDE.md](CLAUDE.md) has the reverse-engineered facts about both APIs — the
ones where getting it wrong loses data silently — and the rules that are not
style preferences. Read it before changing anything.

[docs/FORMAT.md](docs/FORMAT.md) is the archive schema.
[docs/IMPORT_EXPORT.md](docs/IMPORT_EXPORT.md) is the walkthrough with
screenshots.

## Releasing

Tagged here, published from a separate private pipeline that clones the tag,
re-runs `npm run check` against it, and refuses to ship if the committed bundles
do not match the committed source.

## Compatibility

| | |
|---|---|
| Claude Desktop | 1.34493.1 |
| Claude Code CLI | 2.1.239 — Desktop needs ≥ 2.1.234 to import at all |
| claude.ai API | as of 22 August 2026 |
| `import.sh` | macOS |

Both ends are undocumented internal APIs and can change without notice. If an
export returns far fewer conversations than you expect, open an issue with the
counts.

## Licence

MIT
