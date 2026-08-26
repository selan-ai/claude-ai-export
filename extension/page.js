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
  function describeConversationCount(organization) {
    const noun = organization.conversationsSeen === 1 ? "chat" : "chats";
    return `${organization.conversationsSeen}${organization.moreThanSeen ? "+" : ""} ${noun}`;
  }
  var ExportPhase = {
    idle: "idle",
    awaitingSignIn: "awaitingSignIn",
    choosingAccount: "choosingAccount",
    running: "running",
    done: "done",
    failed: "failed"
  };
  var idleState = {
    phase: ExportPhase.idle,
    label: "",
    percent: 0,
    summary: null,
    error: null,
    identity: null,
    organization: null,
    candidates: []
  };
  var MessageKind = {
    start: "start",
    requestState: "requestState",
    progress: "progress",
    awaitingSignIn: "awaitingSignIn",
    awaitingAccountChoice: "awaitingAccountChoice",
    chooseAccount: "chooseAccount",
    source: "source",
    finished: "finished",
    failed: "failed"
  };
  function parseExportMessage(value) {
    if (typeof value !== "object" || value === null) return null;
    const kind = value.kind;
    if (typeof kind !== "string" || !(kind in MessageKind)) return null;
    return value;
  }

  // src/entry/page.ts
  var sourceUrl = "https://github.com/selan-ai/claude-ai-export";
  var bytesPerMegabyte = 1024 * 1024;
  function element(id) {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`missing element: ${id}`);
    return found;
  }
  var ExportPageView = class {
    intro = element("intro");
    running = element("running");
    status = element("status");
    statusNote = element("statusNote");
    bar = element("bar");
    percentLabel = element("pct");
    log = element("log");
    nextSteps = element("next");
    restart = element("again");
    account = element("account");
    chooser = element("choose");
    organizations = element("orgs");
    constructor() {
      element("src").href = sourceUrl;
      element("go").addEventListener("click", () => this.start());
      this.restart.addEventListener("click", () => this.reset());
      chrome.runtime.onMessage.addListener((raw) => this.onMessage(raw));
      chrome.runtime.sendMessage(
        { kind: MessageKind.requestState },
        (state) => this.render(state)
      );
    }
    start() {
      const checked = document.querySelector("input[name=range]:checked");
      this.showRunning();
      this.setProgress(0, "");
      chrome.runtime.sendMessage({
        kind: MessageKind.start,
        rangeDays: parseExportRange(checked?.value ?? "")
      });
    }
    onMessage(raw) {
      const message = parseExportMessage(raw);
      if (message === null) return;
      if (message.kind === MessageKind.awaitingSignIn) {
        this.showAwaitingSignIn();
        return;
      }
      if (message.kind === MessageKind.source) {
        this.showSource(message.identity, message.organization);
        return;
      }
      if (message.kind === MessageKind.awaitingAccountChoice) {
        this.showChoice(message.identity, message.candidates);
        return;
      }
      if (message.kind === MessageKind.progress) {
        this.showRunning();
        this.setProgress(message.percent, message.label);
        this.append(message.label);
        return;
      }
      if (message.kind === MessageKind.finished || message.kind === MessageKind.failed) {
        chrome.runtime.sendMessage(
          { kind: MessageKind.requestState },
          (state) => this.render(state)
        );
      }
    }
    render(state) {
      if (state === void 0 || state.phase === ExportPhase.idle) return;
      if (state.phase === ExportPhase.awaitingSignIn) {
        this.showAwaitingSignIn();
        return;
      }
      if (state.phase === ExportPhase.choosingAccount && state.identity !== null) {
        this.showChoice(state.identity, state.candidates);
        return;
      }
      if (state.identity !== null && state.organization !== null) {
        this.showSource(state.identity, state.organization);
      }
      this.showRunning();
      this.setProgress(state.percent, state.label);
      this.append(state.label);
      if (state.phase === ExportPhase.done && state.summary !== null) this.showComplete(state.summary);
      if (state.phase === ExportPhase.failed) this.showFailure(state.error ?? "The export stopped.");
    }
    showRunning() {
      this.intro.hidden = true;
      this.running.hidden = false;
      this.bar.classList.remove("waiting");
      this.status.textContent = "Exporting…";
      this.statusNote.textContent = "Leave this tab open. It is safe to keep working elsewhere.";
    }
    /** Waiting on a person, not on work — so an indeterminate stripe, not a number. */
    showAwaitingSignIn() {
      this.intro.hidden = true;
      this.running.hidden = false;
      this.bar.classList.add("waiting");
      this.bar.style.width = "100%";
      this.status.textContent = "Sign in to claude.ai";
      this.statusNote.textContent = "We opened claude.ai in another tab. Sign in there and the export starts by itself.";
    }
    /**
     * Names the source of the export, and keeps naming it: the line stays up
     * through the run and the completion screen, so the zip in Downloads can
     * always be traced back to an account someone saw.
     */
    showSource(identity, organization) {
      this.account.textContent = "";
      this.account.append(
        this.span("who", identity.email === "" ? "Signed-in account" : identity.email),
        this.span("dim", "→"),
        this.span("who", organization.name),
        this.span(`kind ${organization.kind}`, organization.kind),
        this.span(
          "dim",
          [
            organization.seatTier,
            describeConversationCount(organization),
            organization.uuid.slice(0, 8)
          ].filter((part) => part !== null).join(" · ")
        )
      );
      this.account.hidden = false;
      this.chooser.hidden = true;
    }
    /** More than one readable account, so the run stops here until someone picks. */
    showChoice(identity, candidates) {
      this.intro.hidden = true;
      this.running.hidden = false;
      this.account.hidden = true;
      this.bar.classList.add("waiting");
      this.bar.style.width = "100%";
      this.status.textContent = "Which account?";
      this.statusNote.textContent = identity.email === "" ? "Pick the organisation to export from." : `Signed in as ${identity.email}.`;
      this.percentLabel.textContent = "";
      this.organizations.textContent = "";
      for (const candidate of candidates) {
        const button = document.createElement("button");
        button.type = "button";
        button.append(
          this.span("name", candidate.name),
          this.span(`kind ${candidate.kind}`, candidate.kind),
          this.span(
            "meta",
            [candidate.seatTier, describeConversationCount(candidate), candidate.uuid.slice(0, 8)].filter((part) => part !== null).join(" · ")
          )
        );
        button.addEventListener("click", () => {
          this.chooser.hidden = true;
          this.showRunning();
          chrome.runtime.sendMessage({
            kind: MessageKind.chooseAccount,
            organizationUuid: candidate.uuid
          });
        });
        this.organizations.appendChild(button);
      }
      this.chooser.hidden = false;
    }
    span(className, text) {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      return span;
    }
    showComplete(summary) {
      this.bar.classList.remove("waiting");
      this.status.textContent = "Export complete";
      this.statusNote.textContent = "Saved to your Downloads folder.";
      this.bar.style.width = "100%";
      this.percentLabel.textContent = `claude-export.zip · ${(summary.zipBytes / bytesPerMegabyte).toFixed(1)} MB`;
      this.append(
        `${summary.conversations} chats · ${summary.projects} projects · ${summary.assets} files`,
        "ok"
      );
      const held = summary.conversationsAvailable;
      if (summary.rangeDays !== 0 && held > summary.conversations) {
        this.append(
          `Only ${summary.conversations} of your ${held} chats fall in the last ${summary.rangeDays} days. Export again with "Everything" to include the rest.`
        );
      }
      if (summary.skipped > 0) {
        this.append(`${summary.skipped} item(s) could not be fetched — listed in skipped.json`);
      }
      this.nextSteps.hidden = false;
      this.restart.hidden = false;
    }
    showFailure(error) {
      this.bar.classList.remove("waiting");
      this.bar.classList.add("failed");
      this.status.textContent = "Could not finish";
      this.statusNote.textContent = "Nothing was saved.";
      this.percentLabel.textContent = "";
      this.append(error, "err");
      this.restart.hidden = false;
    }
    setProgress(percent, label) {
      this.bar.style.width = `${percent}%`;
      this.percentLabel.textContent = label === "" ? "Preparing…" : `${label} · ${percent}%`;
    }
    /** Reopening the page replays state, so repeats are dropped rather than stacked. */
    append(text, className = "") {
      if (text === "") return;
      if (this.log.lastElementChild?.textContent === text) return;
      const row = document.createElement("div");
      if (className !== "") row.className = className;
      row.textContent = text;
      this.log.appendChild(row);
      this.log.scrollTop = this.log.scrollHeight;
    }
    reset() {
      this.log.textContent = "";
      this.account.hidden = true;
      this.account.textContent = "";
      this.chooser.hidden = true;
      this.organizations.textContent = "";
      this.nextSteps.hidden = true;
      this.restart.hidden = true;
      this.bar.classList.remove("failed", "waiting");
      this.bar.style.width = "0%";
      this.running.hidden = true;
      this.intro.hidden = false;
    }
  };
  new ExportPageView();
})();
