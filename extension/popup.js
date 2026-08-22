// Popup: finds the claude.ai tab, injects export.js into it, shows progress.
// All the actual work happens in the page context, where the session lives.

const logEl = document.getElementById('log');
const goEl = document.getElementById('go');

function line(text, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'export-progress') line(msg.text);
});

goEl.addEventListener('click', async () => {
  goEl.disabled = true;
  logEl.textContent = '';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://claude.ai/')) {
    line('Open a claude.ai tab first, then click again.', 'err');
    goEl.disabled = false;
    return;
  }

  line('Starting — this takes a few minutes for a large history.');
  line('You can close this popup; the export keeps running.');

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['export.js'],
    });
    if (result?.error) {
      line(result.error, 'err');
    } else if (result) {
      line('', null);
      line(`Done — ${result.conversations} chats, ${result.projects} projects, ${result.assets} files.`, 'ok');
      line('Saved to your Downloads folder.', 'ok');
      if (result.skipped) line(`${result.skipped} item(s) could not be fetched — see skipped.json in the zip.`);
    }
  } catch (e) {
    line(`Failed: ${e.message}`, 'err');
  }
  goEl.disabled = false;
});
