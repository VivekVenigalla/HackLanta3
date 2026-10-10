# ExpressiveLive: Kinetic Captions & Outbound Voice

A Chrome extension (Manifest V3) built for **Hacklanta**.

- **Hear it:** live captions for any tab (YouTube, Twitch, Meet, Zoom Web) or your mic. The captions *move with the voice*: whispers render thin and faded, normal speech sits at regular weight, and shouting slams in at weight 900 with a micro-shake.
- **Say it:** a slide-out drawer (`Alt+V`) where you type a reply, pick a mood, and hear it spoken right away through **ElevenLabs**.

Prize tracks: **MLH Best Use of ElevenLabs** · **Zero Data Challenge**

## Setup
1. Copy `config.example.js` to `config.js` (a placeholder copy is already there) and paste your ElevenLabs API key.
2. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this folder.
3. Open a page with audio, click the ExpressiveLive icon, and choose **Tab audio** or **Microphone**, then **Start**.
4. Press `Alt+V` (or click the **Voice** pill) to open the outbound voice drawer.

If `Alt+V` clashes with another shortcut, rebind it at `chrome://extensions/shortcuts`.

## Architecture
```
popup ──START_CAPTURE──▶ service worker ──tabCapture.getMediaStreamId──┐
                              │  mints single-use Scribe token          │
                              ▼                                          ▼
                       offscreen document  (AudioContext)
                         MediaStream ─┬─▶ destination (you still hear the tab)
                                      ├─▶ AnalyserNode (fft 256) ─▶ RMS 0..1 (EMA)
                                      └─▶ AudioWorklet ─▶ 16 kHz PCM ─▶ WSS ElevenLabs Scribe v2 realtime
                         transcript + RMS ──▶ service worker ──▶ content script (closed Shadow DOM HUD)

drawer ──SPEAK{text,mood}──▶ service worker ──▶ offscreen: POST /v1/text-to-speech/{voice}/stream
                                                 └─▶ MediaSource streaming playback (starts on first chunk)
```

### Kinetic mapping (modeled on *Caption with Intention*)
Each word is styled by how it was actually spoken. Loudness and pitch are tracked locally ([offscreen/prosody.js](offscreen/prosody.js)) and matched to the word's exact timestamps from Scribe.

| Speech cue | Visual |
|---|---|
| Loudness, **relative to the speaker's own baseline** | Font size 0.72×–1.5×, `wght` 200–900, `wdth` 75–145 |
| Whisper (level < 0.3) | Condensed, slanted, faded; blurs in softly and "breathes" |
| Shout (level > 0.72) | Black weight, extended width, glow; slams in, then shakes |
| Pitch vs. the speaker's average | Word sits higher or lower on the line |
| Rising or falling pitch within a word | Word climbs and tilts (questions) or sinks (trailing off) |
| Speaker (when IDs are present) | Color |
| Timing | Words appear in the rhythm they were spoken |

**Calibration:** a word's loudness is the 80th-percentile dB over its own timestamps. It is compared with the same measure for the speaker's last ~80 finished words (median ± robust spread). So about 1 word in 7 reads as loud and 1 in 6 as a whisper, whatever the source volume. For the first ~10 words the HUD shows "calibrating" and keeps the styling subtle.

Loudness is relative, so a loud YouTube mix and a quiet laptop mic both cover the full whisper-to-shout range. Partial transcripts get an estimate first; each word is then refined in place when its exact timings arrive. Use **Preview kinetic captions** in the popup to see the full range without audio. Captions fade after 3.5 s of silence and their DOM nodes are deleted. The HUD can be dragged; double-click it to re-anchor.

### On-device sentiment
Each finished caption line gets a mood chip (🤩 Excited, 🙂 Positive, ☺️ Warm, 😠 Angry, 🙁 Negative, 😔 Sad, ❗ Emphatic, 🤫 Quiet; neutral lines get none) and a tinted underline.
- **Valence (what was said):** DistilBERT fine-tuned on SST-2, quantized ONNX, run by transformers.js on WASM inside the offscreen document. Model and runtime are bundled in `models/` and `vendor/` (~100 MB) and load in about 0.7 s; inference takes about 40 ms per line. Low-confidence scores count as neutral.
- **Arousal (how it was said):** average word loudness, share of loud words, and pitch movement.
- These combine into a valence × arousal grid, so "best day ever" whispered is *Warm* and shouted is *Excited*.
- Turn it off with `SENTIMENT_ENABLED: false` in `config.js`.

### Mood → ElevenLabs `voice_settings`
| Mood | stability | similarity_boost | style |
|---|---|---|---|
| Excited | 0.30 | 0.85 | 0.70 |
| Calm / Neutral | 0.75 | 0.75 | 0.00 |
| Whisper / Intimate | 0.40 | 0.80 | 0.50 |
| Dramatic / Urgent | 0.20 | 0.90 | 0.80 |

The default model is `eleven_multilingual_v2` with `use_speaker_boost: true`. If you set `TTS_MODEL_ID` to `eleven_v3`, each mood also adds an inline audio tag (e.g. `[whispers]`).

## Zero Data guarantees
- **No accounts, no telemetry, no analytics, no cookies, no backend, no database.**
- Audio is held only in 100 ms worklet buffers that are sent and dropped. Nothing is queued before the socket opens.
- Transcripts exist only as in-flight messages and caption DOM nodes, which are removed after they fade. Nothing is logged to the console.
- Typed TTS text is cleared from the drawer once it is spoken.
- Nothing is written to `chrome.storage.local`. Only capture state (`capturing/tabId/mode`, never content) goes to `chrome.storage.session`, which is memory-only and cleared when the browser closes.
- STT sessions request ElevenLabs **zero-retention** (`enable_logging=false`). Some plans don't allow this; if the socket errors on connect, set `STT_ZERO_RETENTION: false` in `config.js`.
- The only network host contacted is `api.elevenlabs.io`. The font, the sentiment model and its runtime are bundled locally. Remote model downloads and browser model caching are both disabled.

Your API key sits in `config.js`, which is gitignored. Anyone who installs a build containing that file can read the key, so share builds only with a throwaway key.
