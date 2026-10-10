// Popup: start/stop captions, choose source, open the voice drawer.
// No settings are persisted; the caption size lives only for this popup session.
const $ = (id) => document.getElementById(id);
const toggleBtn = $('toggle');
const errorBox = $('error');
const statusPill = $('status');
const statusText = $('status-text');
const segBtns = [...document.querySelectorAll('.seg-btn')];
let mode = 'tab';
let state = { capturing: false };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showError(msg) {
  errorBox.hidden = !msg;
  errorBox.textContent = msg || '';
}

function render() {
  const s = state;
  const status = s.capturing ? (s.status === 'connecting' ? 'connecting' : 'live') : (s.status === 'error' ? 'error' : 'idle');
  statusPill.className = `status ${status}`;
  statusText.textContent = { live: 'Live', connecting: 'Connecting', error: 'Error', idle: 'Idle' }[status];
  toggleBtn.textContent = s.capturing ? 'Stop live captions' : 'Start live captions';
  toggleBtn.classList.toggle('stop', !!s.capturing);
  if (s.capturing && s.mode) mode = s.mode;
  segBtns.forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    b.disabled = !!s.capturing;
  });
  if (s.status === 'error' && s.error) showError(s.error);
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res?.ok) { state = res; render(); }
}

async function micGranted() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    return p.state === 'granted';
  } catch {
    return false;
  }
}

segBtns.forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; render(); }));

toggleBtn.addEventListener('click', async () => {
  showError('');
  toggleBtn.disabled = true;
  try {
    if (state.capturing) {
      const res = await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
      if (res?.ok) state = res;
    } else {
      if (mode === 'mic' && !(await micGranted())) {
        // Offscreen documents can't show the permission prompt; ask once in a tab.
        await chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
        return;
      }
      const tab = await activeTab();
      if (!tab || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
        throw new Error('Open a regular web page (YouTube, Meet, Twitch…) first.');
      }
      state = { ...state, capturing: true, status: 'connecting', mode };
      render();
      const res = await chrome.runtime.sendMessage({ type: 'START_CAPTURE', mode, tabId: tab.id });
      if (!res?.ok) {
        if (res?.error === 'MIC_PERMISSION') {
          await chrome.tabs.create({ url: chrome.runtime.getURL('permission/permission.html') });
          throw new Error('Microphone access is needed. Grant it in the new tab, then try again.');
        }
        throw new Error(res?.error || 'Could not start');
      }
      state = res;
    }
  } catch (err) {
    showError(err.message || String(err));
    await refresh();
  } finally {
    toggleBtn.disabled = false;
    render();
  }
});

$('drawer').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: 'TOGGLE_DRAWER', tabId: tab.id });
  window.close();
});

$('demo').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: 'RUN_DEMO', tabId: tab.id });
  if (!res?.ok) showError(res?.error || 'Open a regular web page first.');
});

$('size').addEventListener('input', async (e) => {
  const size = Number(e.target.value);
  $('size-val').textContent = `${size}px`;
  const tab = await activeTab();
  if (tab) chrome.runtime.sendMessage({ type: 'SET_CAPTION_SIZE', tabId: tab.id, size });
});

// Live status updates from the audio engine.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.source === 'offscreen' && msg.type === 'STATUS') setTimeout(refresh, 50);
});

refresh();
