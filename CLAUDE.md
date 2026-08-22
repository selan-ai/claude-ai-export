# Claude AI Export — working notes

Read this before changing anything. Most of what follows was learned by
reverse-engineering shipped binaries, and several of the rules exist because
breaking them loses a person's data **silently**.

## What this is

A browser extension that exports a claude.ai account — chats, projects,
attachments, scheduled tasks — into a zip that Claude Desktop's importer
accepts. Unofficial, not affiliated with Anthropic.

## Layout

```
src/domain.ts               vocabulary shared across process boundaries
src/claude/ClaudeApi.ts     HTTP against claude.ai: retries, pagination, files
src/claude/ExportMapper.ts  claude.ai payloads -> the importer's schema
src/archive/ZipArchive.ts   store-only zip writer, no dependencies
src/export/ExportSession.ts one run, start to finish
src/entry/collector.ts      injected into the claude.ai page
src/entry/background.ts     service worker; owns a run
src/entry/page.ts           the UI, a view over worker state
src/static/                 manifest.json, export.html, export.css — authored
extension/                  ENTIRELY GENERATED. Never edit. Wiped every build.
```

`src/` is the source. `extension/` is what Chrome loads, and every file in it
is produced by `npm run build` — the bundles by esbuild, the static assets by a
copy. It is committed anyway, for two reasons: "Load unpacked" has to work
straight from a clone, and `npm run verify` needs something to compare a fresh
build against.

`npm run check` = typecheck, lint, tests, and a reproducibility check.

## Rules that are not style preferences

**No runtime dependencies.** The trust argument is that a stranger can audit
this before handing it their conversations. Every dependency added is one they
must audit too. The zip writer is hand-rolled for exactly this reason. Dev
dependencies are fine.

**extension/ is committed and must match source.** `npm run verify` rebuilds
and compares hashes of every file, static assets included. Never edit anything
in `extension/` — the build wipes the directory first, so the edit will vanish.
Never minify: readable output is the point of publishing it at all.

**Never read, log or store a cookie.** `credentials: 'include'` asks the browser
to attach the session; this code never sees it. There is no code path that may
send data anywhere but claude.ai, and the manifest is what proves it. Adding a
host permission would break the central claim in the README.

**Losing data silently is the one unacceptable failure.** Anything that cannot
be fetched goes into `skipped.json` with a reason. Prefer a partial export the
user knows about over an abort, and over a quiet gap.

## Facts about the two APIs, and how they were established

Both ends are undocumented. These were read out of shipped code, not guessed —
if you change behaviour here, verify the same way.

### claude.ai

| Fact | Consequence |
|---|---|
| `rendering_mode=messages&render_all_tools=true` reads a conversation | This is what the web app uses. `rendering_mode=raw` is its *mutation* mode and returns **no content blocks**, which silently drops every artifact and tool result. The original spec used `raw`; the bug showed up as "artifacts are empty". |
| Scheduled tasks live at `organizations/{org}/cowork/scheduled_tasks` | Probing `/scheduled_tasks`, `/routines`, `/schedules` all 404, which is why they were once believed not to exist. |
| The task prompt is at `job_config.ccr.events[0].data.message.content` | Not a top-level field. |
| `files/{uuid}/contents` serves any file type | `/preview` and `/thumbnail` only render images and PDFs; they 404 on `.pptx`, `.zip`. They are fallbacks. |
| An account can belong to several organizations | Some return 403 (`Invalid authorization for organization`). Probe and distinguish "empty" from "forbidden", or you will export nothing from the wrong org. |

### Claude Desktop's importer

Desktop does not parse the zip itself — it shells out to the Claude Code CLI:

```
claude import-conversations <zip> --cwd <staging>   CLAUDE_IMPORT_CONVERSATIONS=1
```

so the CLI's parser *is* the schema. Verified on Desktop 1.34493.1 / CLI 2.1.239.

| Fact | Consequence |
|---|---|
| Project instructions come from `prompt_template` | Any other key is ignored, and the Space arrives with no instructions. |
| Archive members must be `files/<file_uuid>`, no extension | The basename must match `^[a-zA-Z0-9_-]+$`. A dot means the file is dropped without a message. |
| `manifest.json` must be omitted | Supplied and disagreeing by one message, the import fails with `IMPORT_MANIFEST_MISMATCH`. Absent, the importer derives it and it cannot disagree. |
| Only `content` blocks of type `text` survive | Artifacts and tool results must be flattened into text by `ExportMapper`, or they are lost. |
| Projects whose slug falls outside `^[a-zA-Z0-9_-]+$` are dropped | Silently. Worth warning about. |
| Re-import never duplicates, and never updates | Existing sessions are **skipped**, not refreshed. Fixing an export therefore requires removing the previous import first. |
| `MAX_EXPORT_BYTES` is 1 GiB | Plus zip-bomb guards on file count, per-file size and compression ratio. |

## Conventions

Tomas's, from `~/.claude/skills/clean-code`, with one deliberate deviation.

- **Closed sets are one declaration.** `ExportRange`, `ExportPhase`,
  `MessageKind` are frozen objects yielding both a value and a literal-union
  type. Never write the literal again.
- **Deviation: no zod.** The convention says zod enums and zod parsing at
  boundaries. Zod is a runtime dependency, and this extension's whole argument
  is that it has none — so boundaries are parsed by explicit narrow functions
  (`parseExportRange`, `parseExportMessage`) instead. If that ever stops being
  the trade, revisit it.
- **No optional parameters or props.** Every caller states what it wants. Where
  a value is genuinely absent, the type says `| null`.
- **Parse at every boundary.** `chrome.runtime.onMessage` is `any`, and anything
  holding the extension id can post to it.
- **Prove a refactor changed nothing.** For the collector, that means running an
  export before and after and diffing the zip's JSON members.

## Things that have already gone wrong

Kept because each cost a debugging round trip and would be re-discovered.

1. **`rendering_mode=raw`** — see above. The signal was `content: []` on all
   3299 messages; it was visible in the first export and read past.
2. **Progress that reached 100% early** — the bar tracked chats only, so a
   30-day range matching one chat sat at 100% through projects, 157 downloads
   and the zip build. Progress is a share of the *whole* job, clamped at 98
   until a file exists.
3. **A popup cannot own the run** — opening a tab moves focus, Chrome destroys
   the popup, and the pending `await` dies with it. Hence the service worker,
   and hence a page rather than a popup.
4. **`Number('')` is `0`** — and `0` is a real range meaning *everything*. An
   empty selection would have exported someone's whole history. Caught by a
   test, which is why `parseExportRange` rejects empty before coercing.

## Verifying against a real Desktop

The importer will tell you what it wants, and it is faster than reading the
bundle:

```bash
CLAUDE_IMPORT_CONVERSATIONS=1 CLAUDE_CONFIG_DIR=/tmp/c \
  claude import-conversations ~/Downloads/claude-export.zip --cwd /tmp/w --dry-run
```

Expect `imported: conversations=N skipped=0 …` and no `manifest mismatch`.
Desktop's own log at `~/Library/Logs/Claude*` names the exact path it tried to
open when something is missing — that is how the scheduled-task file layout was
found.
