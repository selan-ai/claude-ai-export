#!/bin/bash
#
# Recreates your claude.ai scheduled tasks in Claude Desktop.
#
#   bash import-schedules.sh [path/to/claude-export.zip]
#
# With no argument it finds the newest claude-export*.zip in Downloads, Desktop
# or the current directory — exporting twice gives you "claude-export (1).zip",
# so assuming a fixed name breaks on the second run.
#
# Claude Desktop's importer reads five things out of the archive —
# conversations.json, projects.json, users.json, manifest.json and files/ — and
# nothing else. There is no field for a schedule anywhere in that schema, so
# nothing you could put in a zip would carry one. Desktop's own tasks are local
# files rather than server data, which is what this writes.
#
# Uses only what macOS already has: bash, jq (shipped since macOS 15), unzip and
# date. Nothing to install.
#
# It backs up before writing, and skips tasks that already exist, so running it
# twice is harmless.

set -euo pipefail

SUPPORT="$HOME/Library/Application Support/Claude-3p"
TASK_FILES="$HOME/Claude/Scheduled"

die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
note() { printf '  %s\n' "$1"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$1"; }

command -v jq >/dev/null || die "jq is required. It ships with macOS 15 and later; on older versions: brew install jq"

# Find the export. Newest first, because a second export lands beside the first
# as "claude-export (1).zip" rather than replacing it.
if [ $# -gt 0 ]; then
  ARCHIVE="$1"
  [ -r "$ARCHIVE" ] || die "cannot read $ARCHIVE"
else
  ARCHIVE=$(find "$HOME/Downloads" "$HOME/Desktop" "$PWD" -maxdepth 1 -name 'claude-export*.zip' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1)
  [ -n "$ARCHIVE" ] || die "no claude-export*.zip found in Downloads, Desktop or here.
       Export from claude.ai first, or pass the path:  bash import-schedules.sh /path/to/export.zip"
  printf '\nUsing %s (%s)\n' "$ARCHIVE" "$(date -r "$ARCHIVE" '+%d %b %H:%M')"
fi

unzip -l "$ARCHIVE" 2>/dev/null | grep -q 'conversations.json' \
  || die "$ARCHIVE does not look like a claude.ai export"
[ -d "$SUPPORT" ] || die "Claude Desktop is not set up for a third-party gateway (no $SUPPORT)"

# Desktop keeps two schedulers and reads only the enabled one. The directory
# names are the opposite way round to what they sound like: the cowork scheduler
# stores under local-agent-mode-sessions, the ccd one under claude-code-sessions.
PREFS="$SUPPORT/claude_desktop_config.json"
[ -r "$PREFS" ] || die "cannot read $PREFS"

if [ "$(jq -r '.preferences.coworkScheduledTasksEnabled // false' "$PREFS")" = "true" ]; then
  STORE_DIR="local-agent-mode-sessions"; SCHEDULER="cowork"
elif [ "$(jq -r '.preferences.ccdScheduledTasksEnabled // false' "$PREFS")" = "true" ]; then
  STORE_DIR="claude-code-sessions"; SCHEDULER="ccd"
else
  die "scheduled tasks are turned off in Claude Desktop"
fi

STORE=$(find "$SUPPORT/$STORE_DIR" -name scheduled-tasks.json -maxdepth 3 2>/dev/null | head -1)
[ -n "$STORE" ] || die "no scheduled-tasks.json under $STORE_DIR — open Claude Desktop once first"

TASKS=$(unzip -p "$ARCHIVE" schedules.json 2>/dev/null | jq -c 'if type=="array" then . else (.data // []) end' 2>/dev/null || echo '[]')
COUNT=$(printf '%s' "$TASKS" | jq 'length')
[ "$COUNT" -gt 0 ] || { ok "no scheduled tasks to import"; exit 0; }

printf '\nFound %s scheduled task(s). Scheduler: %s\n\n' "$COUNT" "$SCHEDULER"

if pgrep -xq Claude; then
  note "closing Claude Desktop so the store can be written"
  osascript -e 'quit app "Claude"' >/dev/null 2>&1 || true
  sleep 3
fi

cp "$STORE" "$STORE.bak"
mkdir -p "$TASK_FILES"

added=0
for index in $(seq 0 $((COUNT - 1))); do
  task=$(printf '%s' "$TASKS" | jq -c ".[$index]")

  name=$(printf '%s' "$task" | jq -r '.name // "Untitled task"')
  prompt=$(printf '%s' "$task" | jq -r '.job_config.ccr.events[0].data.message.content // ""')
  cron=$(printf '%s' "$task" | jq -r '.cron_expression // ""')
  next=$(printf '%s' "$task" | jq -r '.next_run_at // ""')
  enabled=$(printf '%s' "$task" | jq -r 'if .enabled == false then "false" else "true" end')

  [ -n "$prompt" ] || { warn "\"$name\" has no prompt body — skipped"; continue; }

  id=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//')
  [ -n "$id" ] || id="task-$index"

  if jq -e --arg id "$id" '.scheduledTasks[]? | select(.id == $id)' "$STORE" >/dev/null 2>&1; then
    note "$name: already present, left alone"
    continue
  fi

  # claude.ai stores cron in UTC; Desktop runs it in local time. next_run_at
  # carries the scheduler's jitter (an 05:00 rule reports 05:05), so the minute
  # and hour come from the cron and next_run_at only fixes the date — which is
  # what decides whether daylight saving applies.
  local_cron=""
  if [ -n "$cron" ]; then
    if [[ "$cron" =~ ^([0-9]{1,2})[[:space:]]+([0-9]{1,2})[[:space:]]+\*[[:space:]]+\*[[:space:]]+(\*|[0-9])$ ]]; then
      mm="${BASH_REMATCH[1]}"; hh="${BASH_REMATCH[2]}"; dow="${BASH_REMATCH[3]}"
      day="${next%%T*}"; [ -n "$day" ] || day=$(date -u +%Y-%m-%d)
      epoch=$(TZ=UTC date -j -f "%Y-%m-%d %H:%M:%S" "$day $(printf '%02d:%02d' "$hh" "$mm"):00" +%s 2>/dev/null || echo "")
      if [ -n "$epoch" ]; then
        local_cron="$(date -r "$epoch" +'%-M %-H') * * $([ "$dow" = "*" ] && echo '*' || date -r "$epoch" +%w)"
        [ "$local_cron" = "$cron" ] || note "$name: $cron UTC → $local_cron local"
      fi
    fi
    [ -n "$local_cron" ] || { local_cron="$cron"; warn "$name: \"$cron\" is not a simple daily or weekly rule — check the time in Desktop"; }
  fi

  # Desktop resolves the body as <taskFilesDir>/<id>/SKILL.md, and its parser
  # needs both name and description in the frontmatter or it reports the file as
  # missing.
  mkdir -p "$TASK_FILES/$id"
  { printf -- '---\nname: %s\ndescription: Imported from claude.ai\n---\n\n%s\n' "$name" "$prompt"; } > "$TASK_FILES/$id/SKILL.md"

  record=$(jq -n --arg id "$id" --arg name "$name" --arg file "$TASK_FILES/$id/SKILL.md" \
                 --arg cron "$local_cron" --argjson enabled "$enabled" \
    '{id: $id, displayName: $name, enabled: $enabled, filePath: $file, createdAt: (now * 1000 | floor)}
     + (if $cron == "" then {} else {cronExpression: $cron} end)')

  tmp=$(mktemp)
  jq --argjson record "$record" '.scheduledTasks = ((.scheduledTasks // []) + [$record])' "$STORE" > "$tmp"
  mv "$tmp" "$STORE"
  ok "$name"
  added=$((added + 1))
done

printf '\n%s task(s) written.\n' "$added"
note "store:   $STORE"
note "prompts: $TASK_FILES"
printf '\nOpen Claude Desktop and look under Scheduled in the sidebar.\n'
printf 'To undo: cp "%s.bak" "%s"\n\n' "$STORE" "$STORE"
