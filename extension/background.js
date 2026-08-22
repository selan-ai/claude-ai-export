// The export takes minutes; a popup does not survive that. Chrome tears the
// popup down the moment focus moves — which is exactly what opening a tab does.
// So the popup only starts and observes: this worker owns the job, and the
// collecting itself runs in the page and finishes even if this worker naps.

let pageTabId = null;

const state = {
  phase: 'idle', // idle | running | login | done | error
  text: '',
  pct: 0,
  summary: null,
  error: null,
};

/** Reuse an open claude.ai tab, else open one in the background. */
async function claudeTab() {
  const [existing] = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (existing) return existing.id;

  // active:false on purpose: focusing a new tab closes the popup, and the user
  // asked to watch the progress rather than be thrown at claude.ai.
  const tab = await chrome.tabs.create({ url: 'https://claude.ai/', active: false });
  await new Promise((resolve) => {
    const onDone = (id, info) => {
      if (id === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onDone);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onDone);
  });
  return tab.id;
}

/**
 * Is there a usable claude.ai session in that tab? Runs in the page so the
 * cookie applies. A logged-out visitor still gets a 200 from some endpoints,
 * so require an account with at least one organization.
 */
async function signedIn(tabId) {
  const [res] = await chrome.scripting
    .executeScript({
      target: { tabId },
      func: async () => {
        try {
          const r = await fetch('/api/bootstrap', { credentials: 'include', cache: 'no-store' });
          if (!r.ok) return false;
          const b = await r.json();
          return Boolean(b?.account?.memberships?.length);
        } catch {
          return false;
        }
      },
    })
    .catch(() => [{ result: false }]);
  return res?.result === true;
}

/**
 * Wait for the person to sign in, then carry on by itself. Polling every few
 * seconds also keeps this worker from being shut down mid-wait.
 */
async function waitForLogin(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    if (state.phase !== 'login') return false; // cancelled
    if (await signedIn(tabId)) return true;
  }
  return false;
}

async function start(days) {
  Object.assign(state, { phase: 'running', text: 'Starting…', pct: 0, summary: null, error: null });
  try {
    const tabId = await claudeTab();

    if (!(await signedIn(tabId))) {
      Object.assign(state, { phase: 'login', text: 'Waiting for sign-in' });
      try {
        chrome.runtime.sendMessage({ type: 'awaiting-login' });
      } catch {
        /* page not open */
      }
      if (!(await waitForLogin(tabId))) {
        if (state.phase === 'login')
          Object.assign(state, { phase: 'error', error: 'Timed out waiting for sign-in to claude.ai.' });
        return;
      }
      Object.assign(state, { phase: 'running', text: 'Signed in — starting…' });
      if (pageTabId !== null) await chrome.tabs.update(pageTabId, { active: true }).catch(() => {});
    }
    // executeScript(files:) passes no arguments, but both injections share one
    // isolated world, so a global set here is visible to export.js.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (d) => {
        globalThis.__CLAUDE_EXPORT_DAYS = d;
      },
      args: [days],
    });
    // Deliberately not awaited: the page keeps collecting regardless of this
    // worker's lifetime, and progress arrives by message.
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['export.js'] })
      .catch((e) => Object.assign(state, { phase: 'error', error: e.message }));
  } catch (e) {
    Object.assign(state, { phase: 'error', error: e.message });
  }
}

// No default_popup in the manifest, so the icon click lands here.
//
// The obvious way to find an already-open page is tabs.query({url}), but the
// url filter needs the "tabs" permission for anything the host permissions do
// not already cover — including our own extension pages. That permission is
// not worth widening the manifest for, so remember the tab instead and fall
// back to opening a new one if the id is stale or this worker restarted.
chrome.action.onClicked.addListener(async () => {
  if (pageTabId !== null) {
    const tab = await chrome.tabs.get(pageTabId).catch(() => null);
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
    pageTabId = null;
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('export.html') });
  pageTabId = tab.id;
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'start') {
    start(msg.days);
    respond({ ok: true });
    return true;
  }
  if (msg?.type === 'getState') {
    respond(state);
    return true;
  }
  if (msg?.type === 'export-progress') {
    state.text = msg.text ?? state.text;
    // Clamp below 100: only a finished, downloaded export earns a full bar.
    if (typeof msg.pct === 'number') state.pct = Math.min(98, Math.round(msg.pct));
  }
  if (msg?.type === 'export-done') {
    Object.assign(state, { phase: 'done', summary: msg.summary, pct: 100 });
  }
  if (msg?.type === 'export-error') {
    Object.assign(state, { phase: 'error', error: msg.error });
  }
  return false;
});
