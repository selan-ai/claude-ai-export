// Popup: opens claude.ai if needed, injects export.js there, shows progress.
// The work happens in the page because that is the only place the session lives.

const REPO = 'https://github.com/selan-ai/claude-ai-export';

const $ = (id) => document.getElementById(id);
document.getElementById('src').href = REPO;

function line(text, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = text;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'export-progress') line(msg.text);
});

/** Reuse an open claude.ai tab, or open one and wait for it to finish loading. */
async function claudeTab() {
  const [existing] = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }
  line('Opening claude.ai…');
  const tab = await chrome.tabs.create({ url: 'https://claude.ai/', active: true });
  await new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
  });
  return tab.id;
}

$('go').addEventListener('click', async () => {
  const days = Number(document.querySelector('input[name=range]:checked').value);

  $('intro').hidden = true;
  $('running').hidden = false;

  try {
    const tabId = await claudeTab();

    // executeScript(files:) takes no arguments, but both injections share the
    // same isolated world, so a global set here is visible to export.js.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (d) => {
        globalThis.__CLAUDE_EXPORT_DAYS = d;
      },
      args: [days],
    });

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['export.js'],
    });

    if (!result || result.error) {
      $('status').textContent = 'Could not finish';
      $('statusNote').textContent = 'Nothing was saved.';
      line(result?.error ?? 'The export stopped unexpectedly.', 'err');
    } else {
      $('status').textContent = 'Export complete';
      $('statusNote').textContent = 'Saved to your Downloads folder.';
      line('', null);
      line(`${result.conversations} chats · ${result.projects} projects · ${result.assets} files`, 'ok');
      line(`claude-export.zip (${(result.zipBytes / 1024 / 1024).toFixed(1)} MB)`, 'ok');
      if (result.skipped) line(`${result.skipped} item(s) could not be fetched — listed in skipped.json`);
    }
  } catch (e) {
    $('status').textContent = 'Could not finish';
    $('statusNote').textContent = 'Nothing was saved.';
    line(e.message, 'err');
  }

  $('again').hidden = false;
  $('again').addEventListener('click', () => window.close());
});
