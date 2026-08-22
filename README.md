# Claude AI Export

Export your **claude.ai** chats, projects, attachments and scheduled tasks to a
zip on your own computer — and import them into **Claude Desktop**.

Unofficial. Not affiliated with Anthropic.

Built for people whose workspace admin has not enabled member data export, and
for anyone who wants a local copy of their own conversations.

## What it saves

| | |
|---|---|
| Chats | full message trees, including edited/regenerated branches |
| Chat ↔ project grouping | preserved |
| Projects | name, instructions, knowledge documents |
| Attachments | text inline, images and files downloaded |
| Scheduled tasks | exported as JSON |
| Memory | not exportable |

## Why it runs in the browser

Your claude.ai session cookie is `httpOnly` — only code running on a claude.ai
page can use it. A desktop app or CLI would have to extract cookies out of your
browser, which is both fragile and a bad idea. So the extension asks the browser
to attach the cookie for it, and never sees the value.

## It cannot send your data anywhere

You do not have to take that on trust. Read `extension/manifest.json`:

```json
"permissions": ["scripting"],
"host_permissions": ["https://claude.ai/*"],
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'none'"
}
```

`claude.ai` is the only host it may contact. There is no analytics endpoint, no
remote config, and the CSP forbids loading remote code. Those three lines are
checkable in thirty seconds, without reading any logic.

It also has **no runtime dependencies** — not even a zip library; that is
hand-rolled so there is nothing extra to audit.

The source is TypeScript, so there is a build. The output is committed, never
minified, and reproducible:

```bash
npm ci && npm run verify
```

That rebuilds `extension/*.js` from `src/` and fails if a single byte differs
from what is committed. So "the published code is the code that runs" stays
checkable rather than being something you take on faith.

## Install

Not on the Chrome Web Store yet. Load it directly:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the extension icon — it opens claude.ai for you if it needs to, and
   waits if you are not signed in
4. Choose a date range → **Start export**

A few minutes later `claude-export.zip` lands in Downloads. Around 25 MB for
~350 conversations.

## Development

```bash
npm ci
npm run check     # typecheck, lint, tests, reproducible-build check
npm run build     # rebuild extension/*.js from src/
```

TypeScript 7, Biome, and Node's built-in test runner. No test framework, no
bundler config beyond one esbuild call. See [CLAUDE.md](CLAUDE.md) for the
reverse-engineered facts about both APIs and the rules that are not style
preferences.

Works in Chrome, Edge, Brave and Arc. Firefox needs a small manifest change;
Safari needs an Xcode wrapper.

## Import into Claude Desktop

Claude Desktop has a built-in importer, available when it runs in third-party
mode:

**Settings → Import & export → Import… → Choose file…** → your zip.

Notes:

- Re-running the import **does not create duplicates**, but it also **does not
  update chats already imported** — existing sessions are skipped, not
  refreshed.
- Scheduled tasks are not carried by the zip. `schedules.json` inside it has
  everything needed to recreate them; see [docs/SCHEDULES.md](docs/SCHEDULES.md).

## Zip format

See [docs/FORMAT.md](docs/FORMAT.md) — the exact schema Claude Desktop's
importer parses, and the four details that silently lose data if you get them
wrong.

## Compatibility

Verified against:

| | |
|---|---|
| Claude Desktop | 1.34493.1 |
| Claude Code CLI | 2.1.239 (Desktop requires ≥ 2.1.234 to import) |
| claude.ai API | as of 2026-08-22 |

Both ends are undocumented internal APIs and can change without notice. If an
export comes back with far fewer conversations than you expect, open an issue
with the counts.

## Licence

MIT
