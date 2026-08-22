// The export takes minutes; a popup does not survive that. Chrome tears the
// popup down the moment focus moves — which is exactly what opening a tab does.
// So the popup only starts and observes: this worker owns the job, and the
// collecting itself runs in the page and finishes even if this worker naps.

const state = {
  phase: 'idle', // idle | running | done | error
  text: '',
  done: 0,
  total: 0,
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

async function start(days) {
  Object.assign(state, { phase: 'running', text: 'Starting…', done: 0, total: 0, summary: null, error: null });
  try {
    const tabId = await claudeTab();
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
let pageTabId = null;

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
    if (typeof msg.done === 'number') state.done = msg.done;
    if (typeof msg.total === 'number') state.total = msg.total;
  }
  if (msg?.type === 'export-done') {
    Object.assign(state, { phase: 'done', summary: msg.summary, done: state.total });
  }
  if (msg?.type === 'export-error') {
    Object.assign(state, { phase: 'error', error: msg.error });
  }
  return false;
});
