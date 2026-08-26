# Changelog

Versions follow the extension's `manifest.json`, which is what the Chrome Web
Store reads. `package.json` is kept in step with it by hand.

## 1.0.0 — 2026-08-26

The first version that names what it exported. Everything below 1.0.0 could
produce an archive you had no way to check.

### The account an export comes from is now on screen

The organization was picked by whichever held the most conversations, and
nothing said which one. A work seat and a personal subscription routinely sit
on the same email address — the account this was built against has three
organizations behind one — so the silent pick was right most of the time and
wrong the rest, with no way to tell which had happened.

- The signed-in account is read once from `/api/bootstrap`, and the source is
  named on the export page *before* a conversation is read.
- Organizations without the `chat` capability are skipped. They are API/Console
  organizations, they hold no conversations, and they answer 403.
- Each remaining one is classified work or personal from `seat_tier`, plan
  capability and name. An organization that cannot be shown to be personal is
  called work: a personal export mislabelled work is a surprise, a work export
  mislabelled personal is a false all-clear.
- With more than one readable organization, the extension asks instead of
  guessing. Nothing is read until you pick.
- `export-source.json` is stamped into the zip, so an archive names its own
  origin long after you have forgotten which account made it.

### A thin export now says so

A 30-day export of an account whose history is older looks successful and is
nearly empty — 613 KB against 25 MB, with nothing on screen explaining why. The
completion screen reports how many of your chats the window actually covered.

### Scheduled tasks can be imported

Schedules cannot ride the archive: the importer reads five members and none of
them is a schedule, and Desktop's tasks are local files rather than server data.
`scripts/import.sh` writes them using only what macOS already ships — no Node,
since most people importing will not have it. It finds the export itself,
because assuming `~/Downloads/claude-export.zip` breaks the moment someone
exports twice and gets `claude-export (1).zip`.

The script covers both halves of the move: it writes the scheduled tasks the
wizard cannot carry, then opens Desktop with the archive already selected.

### Documentation

`docs/IMPORT_EXPORT.md` walks the whole move with screenshots, including the two
Desktop screens people actually have to find, and writes down what is only
obvious after it has gone wrong: that re-running an import never refreshes a
chat it already has, and that a cron copied across unchanged fires three hours
early.

## 0.1.0 — 2026-08-22

First release. Exports chats with full history, projects, attachments and
scheduled tasks into a zip that Claude Desktop's importer accepts. No runtime
dependencies, no server, and no host permission but `https://claude.ai/*`.
