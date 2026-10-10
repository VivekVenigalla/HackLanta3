// ExpressiveLive service worker: message router + capture lifecycle.
// ZERO DATA: transcripts and audio pass through here only as transient
// messages. Nothing is logged, persisted, or sent anywhere except ElevenLabs.
import { CONFIG } from '../config.js';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const API = 'https://api.elevenlabs.io';

// Mood presets (MLH ElevenLabs track): mapped to voice_settings.
const MOODS = {
  excited:  { stability: 0.3,  similarity_boost: 0.85, style: 0.7, tag: '[excited]' },
  calm:     { stability: 0.75, similarity_boost: 0.75, style: 0.0, tag: '[calm]' },
  whisper:  { stability: 0.4,  similarity_boost: 0.8,  style: 0.5, tag: '[whispers]' },
  dramatic: { stability: 0.2,  similarity_boost: 0.9,  style: 0.8, tag: '[urgent]' },
};

// Capture state lives in chrome.storage.session (RAM only, never written to
// disk, cleared when the browser closes) so it survives SW restarts.
async function getState() {
  const { el_state } = await chrome.storage.session.get('el_state');
  return el_state || { capturing: false, tabId: null, mode: null, status: 'idle', error: null };
}
async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ el_state: next });
  return next;
}

// ---------- offscreen document ----------
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab/mic audio for live captions and play synthesized speech.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

// ---------- content script helpers ----------
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    } catch {
      // chrome://, Web Store, etc. cannot be scripted. Captions just won't show.
    }
  }
}

function toTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ---------- ElevenLabs single-use token for browser WebSocket auth ----------
async function mintScribeToken() {
  const res = await fetch(`${API}/v1/single-use-token/realtime_scribe`, {
    method: 'POST',
    headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY },
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status}). Check your ElevenLabs API key.`);
  const { token } = await res.json();
  return token;
}

// ---------- capture lifecycle ----------
async function startCapture({ mode, tabId }) {
  const state = await getState();
  if (state.capturing) await stopCapture();

  await ensureContentScript(tabId);
  await ensureOffscreen();

  let streamId = null;
  if (mode === 'tab') {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
  const token = await mintScribeToken();

  await setState({ capturing: true, tabId, mode, status: 'connecting', error: null });
  toTab(tabId, { type: 'CAPTURE_STATE', capturing: true, mode });

  const res = await toOffscreen({
    type: 'START',
    mode,
    streamId,
    token,
    modelId: CONFIG.STT_MODEL_ID,
    zeroRetention: CONFIG.STT_ZERO_RETENTION,
    sentiment: CONFIG.SENTIMENT_ENABLED !== false,
  });
  if (!res?.ok) {
    await setState({ capturing: false, status: 'error', error: res?.error || 'Failed to start audio' });
    toTab(tabId, { type: 'CAPTURE_STATE', capturing: false });
    throw new Error(res?.error || 'Failed to start audio');
  }
  return getState();
}

async function stopCapture() {
  const state = await getState();
  if (await chrome.offscreen.hasDocument()) {
    await toOffscreen({ type: 'STOP' }).catch(() => {});
  }
  toTab(state.tabId, { type: 'CAPTURE_STATE', capturing: false });
  return setState({ capturing: false, status: 'idle', error: null, mode: null });
}

// ---------- outbound TTS ----------
async function speak({ text, mood, voiceId }) {
  const preset = MOODS[mood] || MOODS.calm;
  const modelId = CONFIG.TTS_MODEL_ID;
  // eleven_v3 understands inline audio tags; v2 relies on voice_settings alone.
  const finalText = modelId === 'eleven_v3' ? `${preset.tag} ${text}` : text;
  await ensureOffscreen();
  return toOffscreen({
    type: 'SPEAK',
    text: finalText,
    voiceId: voiceId || CONFIG.DEFAULT_VOICE_ID,
    modelId,
    voiceSettings: {
      stability: preset.stability,
      similarity_boost: preset.similarity_boost,
      style: preset.style,
      use_speaker_boost: true,
    },
  });
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // not for us

  // Messages coming from the offscreen document: forward to the captioned tab.
  if (msg?.source === 'offscreen') {
    (async () => {
      const { tabId } = await getState();
      if (msg.type === 'CAPTION' || msg.type === 'LEVEL' || msg.type === 'SENTIMENT') {
        toTab(tabId, msg);
      } else if (msg.type === 'STATUS') {
        await setState({ status: msg.status, error: msg.error || null });
        if (msg.status === 'ended' || msg.status === 'error') {
          await setState({ capturing: false });
          toTab(tabId, { type: 'CAPTURE_STATE', capturing: false, error: msg.error });
        }
      } else if (msg.type === 'SPEAK_STATE') {
        // Broadcast speaking state to whichever tab asked; simplest: active tab.
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) toTab(tab.id, msg);
      }
    })();
    return false;
  }

  const handlers = {
    GET_STATE: () => getState(),
    START_CAPTURE: () => startCapture(msg),
    STOP_CAPTURE: () => stopCapture(),
    SPEAK: () => speak(msg),
    GET_DEFAULTS: async () => ({ voiceId: CONFIG.DEFAULT_VOICE_ID, modelId: CONFIG.TTS_MODEL_ID }),
    TOGGLE_DRAWER: async () => {
      await ensureContentScript(msg.tabId);
      toTab(msg.tabId, { type: 'TOGGLE_DRAWER' });
      return { ok: true };
    },
    RUN_DEMO: async () => {
      await ensureContentScript(msg.tabId);
      toTab(msg.tabId, { type: 'RUN_DEMO' });
      return { ok: true };
    },
    SET_CAPTION_SIZE: async () => {
      toTab(msg.tabId, { type: 'SET_CAPTION_SIZE', size: msg.size });
      return { ok: true };
    },
  };

  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // async response
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-drawer') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  await ensureContentScript(tab.id);
  toTab(tab.id, { type: 'TOGGLE_DRAWER' });
});

// If the captioned tab closes, release the capture.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.capturing && state.tabId === tabId) stopCapture();
});
