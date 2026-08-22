// This page is a view, not the worker. background.js owns the job, so closing
// the tab does not stop an export that is already running.

const REPO = 'https://github.com/selan-ai/claude-ai-export';

const $ = (id) => document.getElementById(id);
$('src').href = REPO;

function line(text, cls) {
  if (!text) return;
  const log = $('log');
  const last = log.lastElementChild;
  if (last && last.textContent === text) return; // reopened popup replays state
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

function showRunning() {
  $('intro').hidden = true;
  $('running').hidden = false;
}

function progress(pct, text) {
  $('bar').style.width = `${pct ?? 0}%`;
  $('pct').textContent = text ? `${text} · ${pct ?? 0}%` : 'Preparing…';
}

function showLogin() {
  showRunning();
  $('status').textContent = 'Sign in to claude.ai';
  $('statusNote').textContent =
    'We opened claude.ai in another tab. Sign in there and the export starts by itself — you do not need to come back here.';
  $('bar').classList.add('waiting');
}

function clearLogin() {
  $('bar').classList.remove('waiting');
}

function finish(state) {
  if (state.phase === 'done' && state.summary) {
    const s = state.summary;
    $('status').textContent = 'Export complete';
    $('statusNote').textContent = 'Saved to your Downloads folder.';
    clearLogin();
    $('bar').style.width = '100%';
    $('pct').textContent = `claude-export.zip · ${(s.zipBytes / 1024 / 1024).toFixed(1)} MB`;
    line(`${s.conversations} chats · ${s.projects} projects · ${s.assets} files`, 'ok');
    if (s.skipped) line(`${s.skipped} item(s) could not be fetched — listed in skipped.json`);
    $('next').hidden = false;
    $('again').hidden = false;
  } else if (state.phase === 'error') {
    $('status').textContent = 'Could not finish';
    $('statusNote').textContent = 'Nothing was saved.';
    $('bar').classList.add('failed');
    $('pct').textContent = '';
    line(state.error ?? 'The export stopped unexpectedly.', 'err');
    $('again').hidden = false;
  }
}

// Live updates while the popup happens to be open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'export-progress') {
    showRunning();
    clearLogin();
    $('status').textContent = 'Exporting…';
    $('statusNote').textContent = 'Leave this tab open. It is safe to keep working elsewhere.';
    line(msg.text);
    if (typeof msg.pct === 'number') progress(Math.min(98, Math.round(msg.pct)), msg.text);
  }
  if (msg?.type === 'export-done' || msg?.type === 'export-error') {
    chrome.runtime.sendMessage({ type: 'getState' }, finish);
  }
  if (msg?.type === 'awaiting-login') showLogin();
});

// Reopening mid-run should show the run, not the start screen.
chrome.runtime.sendMessage({ type: 'getState' }, (state) => {
  if (!state || state.phase === 'idle') return;
  if (state.phase === 'login') return showLogin();
  showRunning();
  progress(state.pct, state.text);
  line(state.text);
  finish(state);
});

$('go').addEventListener('click', () => {
  const days = Number(document.querySelector('input[name=range]:checked').value);
  showRunning();
  progress(0, '');
  chrome.runtime.sendMessage({ type: 'start', days });
});

// The page persists, so "again" returns to the start screen rather than closing.
$('again').addEventListener('click', () => {
  $('log').textContent = '';
  $('next').hidden = true;
  $('again').hidden = true;
  $('bar').classList.remove('failed');
  $('bar').style.width = '0%';
  $('running').hidden = true;
  $('intro').hidden = false;
});
