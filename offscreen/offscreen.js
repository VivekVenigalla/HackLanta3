// ExpressiveLive audio engine (offscreen document).
// - Captures tab audio or mic, measures loudness + pitch locally (prosody.js).
// - Streams 16 kHz PCM to ElevenLabs Scribe realtime for STT.
// - Plays ElevenLabs TTS for the outbound voice drawer.
// ZERO DATA: audio chunks are base64'd, sent, and dropped. Transcripts are
// forwarded as messages and never stored or logged.
import { CONFIG } from '../config.js';
import { Prosody } from './prosody.js';

const STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

const LEVEL_INTERVAL_MS = 33;
const CHUNK_SEC = 0.1;        // PCM chunk length posted by the worklet
const PARTIAL_LAG_SEC = 0.3;  // rough STT latency: partial text trails the audio

let session = null; // { stream, ctx, analyser, worklet, ws, timer, ... }

function emit(msg) {
  chrome.runtime.sendMessage({ source: 'offscreen', ...msg }).catch(() => {});
}

// ---------- capture ----------
async function getStream(mode, streamId) {
  if (mode === 'tab') {
    return navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
}

function int16ToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function openScribe({ token, modelId, zeroRetention }) {
  const params = new URLSearchParams({
    model_id: modelId || 'scribe_v2_realtime',
    token,
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    include_timestamps: 'true', // word timings → per-word loudness/pitch
  });
  if (zeroRetention) params.set('enable_logging', 'false');
  return new WebSocket(`${STT_URL}?${params}`);
}

async function start({ mode, streamId, token, modelId, zeroRetention, sentiment }) {
  stop();

  const stream = await getStream(mode, streamId);
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const source = ctx.createMediaStreamSource(stream);

  // 2048 samples (~43 ms) gives a stable loudness reading and enough signal
  // for pitch detection down to ~70 Hz.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  // Tab capture mutes the tab for the user; route it back to the speakers.
  if (mode === 'tab') source.connect(ctx.destination);

  try {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    throw err;
  }
  const worklet = new AudioWorkletNode(ctx, 'pcm-downsampler', { numberOfOutputs: 0 });
  source.connect(worklet);

  const s = {
    stream, ctx, source, analyser, worklet, ws: null, timer: null,
    prosody: new Prosody(ctx.sampleRate),
    t0: null,            // ctx time that corresponds to STT time 0
    seg: newSegment(),   // words of the utterance currently being transcribed
    pendingCommit: null,
    lastFinal: { text: '', at: 0 },
    speakers: new Map(),
    lineSeq: 0,
    sentiment: !!sentiment,
    sentimentWarned: false,
  };
  session = s;
  if (s.sentiment) loadSentiment().catch(() => {}); // warm the model while STT connects

  // ---- prosody loop (offscreen docs have no reliable rAF, so use a timer) ----
  const buf = new Float32Array(analyser.fftSize);
  s.timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    const { level, isSpeech } = s.prosody.push(ctx.currentTime, buf);
    emit({ type: 'LEVEL', level: isSpeech ? level : 0 });
  }, LEVEL_INTERVAL_MS);

  // ---- STT socket ----
  const ws = openScribe({ token, modelId, zeroRetention });
  s.ws = ws;

  worklet.port.onmessage = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return; // drop: never buffer audio
    // The first chunk sent holds the previous 100 ms of audio.
    if (s.t0 == null) s.t0 = ctx.currentTime - CHUNK_SEC;
    ws.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: int16ToBase64(e.data),
      commit: false,
      sample_rate: 16000,
    }));
  };

  ws.onopen = () => emit({ type: 'STATUS', status: 'listening' });
  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    const t = data.message_type;
    if (t === 'partial_transcript') onPartial(s, data.text || '');
    else if (t === 'committed_transcript') onCommitted(s, data.text || '');
    else if (t === 'committed_transcript_with_timestamps') onCommittedTimed(s, data);
    else if (t === 'session_started') emit({ type: 'STATUS', status: 'listening' });
    else if (data.error) {
      emit({ type: 'STATUS', status: 'error', error: `${t}: ${data.error}` });
      stop();
    }
  };
  ws.onerror = () => {
    if (session === s) emit({ type: 'STATUS', status: 'error', error: 'Speech-to-text connection failed' });
  };
  ws.onclose = (e) => {
    if (session === s) {
      emit({ type: 'STATUS', status: 'ended', error: e.code !== 1000 && e.reason ? e.reason : null });
      stop();
    }
  };

  // Stop if the user ends the capture from Chrome's UI or the tab goes away.
  stream.getAudioTracks().forEach((track) => {
    track.onended = () => {
      if (session === s) {
        emit({ type: 'STATUS', status: 'ended' });
        stop();
      }
    };
  });
}

// ---------- word-level styling ----------
// Each caption word carries how it was spoken:
//   level 0..1 (relative loudness), pitch/slope in semitones vs. the speaker's
//   baseline, speaker index, and a reveal delay so words pop in speech rhythm.

function newSegment() {
  return { words: [], lastT: null };
}

function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

// Partials have no timestamps: spread the newly appeared words over the audio
// heard since the previous partial and measure each slice.
function onPartial(s, text) {
  const words = splitWords(text);
  if (!words.length) return;
  const seg = s.seg;
  const now = s.ctx.currentTime - PARTIAL_LAG_SEC;
  const fresh = words.length - seg.words.length;

  if (fresh > 0) {
    const t0 = seg.lastT ?? now - fresh * 0.3;
    const per = Math.max((now - t0) / fresh, 0.12);
    const stagger = Math.min(per * 1000, 90);
    for (let j = 0; j < fresh; j++) {
      const a = t0 + j * per;
      const w = s.prosody.window(a, a + per);
      seg.words.push({ text: words[seg.words.length], ...w, speaker: 0, delay: Math.round(j * stagger) });
    }
  }
  seg.words.length = words.length; // partial may have shrunk
  for (let i = 0; i < words.length; i++) seg.words[i].text = words[i];
  seg.lastT = now;
  emit({
    type: 'CAPTION',
    words: seg.words.map(stripDelay(fresh)).map(({ db, ...w }) => w),
    isFinal: false,
    calibrated: s.prosody.calibrated,
  });
}

// Only the newest words animate in; older ones keep their delay at 0.
function stripDelay(fresh) {
  return (w, i, arr) => (i < arr.length - Math.max(fresh, 0) ? { ...w, delay: 0 } : w);
}

// Plain commit: wait briefly for the timestamped version, else finalize as-is.
function onCommitted(s, text) {
  if (!text.trim()) return;
  if (text === s.lastFinal.text && performance.now() - s.lastFinal.at < 2000) return; // timed one already won
  clearTimeout(s.pendingCommit);
  s.pendingCommit = setTimeout(() => {
    const words = splitWords(text);
    const seg = s.seg;
    for (let i = 0; i < words.length; i++) {
      if (seg.words[i]) seg.words[i].text = words[i];
      else seg.words.push({ text: words[i], level: 0.5, pitch: 0, slope: 0, speaker: 0, delay: 0 });
    }
    seg.words.length = words.length;
    finalize(s, text, seg.words.map((w) => ({ ...w, delay: 0 })));
  }, 350);
}

// Timestamped commit: measure loudness/pitch over each word's exact span.
function onCommittedTimed(s, data) {
  const list = (data.words || []).filter((w) => w.type === 'word' && w.text?.trim());
  if (!list.length || s.t0 == null) return;
  clearTimeout(s.pendingCommit);

  // Timestamps should be session-relative; if they don't line up with the
  // audio we've measured, assume segment-relative and anchor to "just now".
  const now = s.ctx.currentTime;
  const maxEnd = Math.max(...list.map((w) => w.end));
  let offset = s.t0;
  if (offset + maxEnd > now + 0.5 || offset + maxEnd < now - 15) offset = now - 0.4 - maxEnd;

  const shown = s.seg.words.length;
  const firstNew = list[Math.min(shown, list.length - 1)]?.start ?? 0;
  const words = list.map((w, i) => {
    const m = s.prosody.window(offset + w.start, offset + w.end);
    return {
      text: w.text.trim(),
      ...m,
      speaker: speakerIndex(s, w.speaker_id),
      // Words not yet on screen reveal in their real spoken rhythm.
      delay: i < shown ? 0 : Math.round(Math.min(Math.max(0, w.start - firstNew), 1.2) * 1000),
    };
  });
  finalize(s, data.text || words.map((w) => w.text).join(' '), words);
}

function finalize(s, text, words) {
  s.lastFinal = { text, at: performance.now() };
  s.seg = newSegment();
  const lineId = ++s.lineSeq;
  const out = words.map(({ db, ...w }) => w); // dB stays in the engine
  emit({ type: 'CAPTION', words: out, isFinal: true, lineId, calibrated: s.prosody.calibrated });
  // Only finalized words become the loudness reference for later words.
  s.prosody.record(words.map((w) => w.db));
  if (s.sentiment) classifyLine(s, lineId, text, out);
}

// ---------- sentiment (on-device, see sentiment.js) ----------
let sentimentModule = null;
function loadSentiment() {
  // Dynamic import so a model/runtime failure can never break captions.
  sentimentModule ??= import('./sentiment.js').then(async (m) => { await m.warmUp(); return m; });
  return sentimentModule;
}

async function classifyLine(s, lineId, text, words) {
  try {
    const m = await loadSentiment();
    const result = await m.analyze(text, words);
    if (session === s) emit({ type: 'SENTIMENT', lineId, ...result });
  } catch (err) {
    sentimentModule = null;
    if (!s.sentimentWarned && session === s) {
      s.sentimentWarned = true;
      emit({ type: 'STATUS', status: 'listening', error: `Sentiment unavailable: ${err?.message || err}` });
    }
  }
}

function speakerIndex(s, id) {
  if (id == null) return 0;
  if (!s.speakers.has(id)) s.speakers.set(id, s.speakers.size % 4);
  return s.speakers.get(id);
}

function stop() {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.timer);
  clearTimeout(s.pendingCommit);
  try { s.worklet.port.onmessage = null; s.worklet.disconnect(); } catch {}
  try { s.source.disconnect(); } catch {}
  try { s.ws && s.ws.close(1000); } catch {}
  s.stream.getTracks().forEach((t) => t.stop());
  s.ctx.close().catch(() => {});
  s.prosody.clear();
  s.seg = null;
}

// ---------- outbound TTS playback ----------
let player = null; // { audio, url, abort }

function stopPlayback() {
  if (!player) return;
  player.abort.abort();
  player.audio.pause();
  URL.revokeObjectURL(player.url);
  player = null;
}

async function speak({ text, voiceId, modelId, voiceSettings }) {
  stopPlayback();
  const abort = new AbortController();
  const res = await fetch(
    `${TTS_URL}/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`,
    {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'xi-api-key': CONFIG.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings }),
    },
  );
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail?.message || ''; } catch {}
    throw new Error(`ElevenLabs TTS ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  // Stream MP3 into MediaSource so playback starts on the first chunk.
  const mediaSource = new MediaSource();
  const audio = new Audio();
  const url = URL.createObjectURL(mediaSource);
  audio.src = url;
  const p = { audio, url, abort };
  player = p;

  await new Promise((resolve) => mediaSource.addEventListener('sourceopen', resolve, { once: true }));
  const sb = mediaSource.addSourceBuffer('audio/mpeg');
  const reader = res.body.getReader();

  const append = (chunk) => new Promise((resolve, reject) => {
    sb.addEventListener('updateend', resolve, { once: true });
    sb.addEventListener('error', reject, { once: true });
    sb.appendBuffer(chunk);
  });

  audio.onended = () => {
    if (player === p) stopPlayback();
    emit({ type: 'SPEAK_STATE', state: 'ended' });
  };

  let started = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || player !== p) break;
        await append(value);
        if (!started) {
          started = true;
          audio.play().catch(() => {});
          emit({ type: 'SPEAK_STATE', state: 'playing' });
        }
      }
      if (player === p && mediaSource.readyState === 'open') mediaSource.endOfStream();
    } catch {
      if (player === p) {
        stopPlayback();
        emit({ type: 'SPEAK_STATE', state: 'ended' });
      }
    }
  })();
  // Resolve once audio is flowing (or the stream ended without data).
  await Promise.race([
    pump,
    new Promise((r) => {
      const check = setInterval(() => { if (started) { clearInterval(check); r(); } }, 20);
      pump.finally(() => clearInterval(check));
    }),
  ]);
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const run = {
    START: () => start(msg),
    STOP: async () => stop(),
    SPEAK: () => speak(msg),
    STOP_SPEAK: async () => stopPlayback(),
  }[msg.type];
  if (!run) return false;
  run()
    .then(() => sendResponse({ ok: true }))
    .catch((err) => {
      const name = err?.name;
      const error = name === 'NotAllowedError'
        ? 'MIC_PERMISSION'
        : err?.message || String(err);
      sendResponse({ ok: false, error });
    });
  return true;
});
