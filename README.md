# ExpressiveLive

**Captions that show *how* something was said, and a voice that can say it back with feeling.**

A Chrome extension built for **Hacklanta**.
Prize tracks: **MLH Best Use of ElevenLabs** · **Zero Data Challenge**

---

## Why we built it

Standard captions flatten speech. A whisper, a joke, a scream and a sarcastic aside all show up as the same plain white text. Deaf and hard-of-hearing viewers lose the tone, the emphasis and the emotion, and often can't tell what a moment actually *felt* like.

ExpressiveLive puts that back, in any browser tab, live:

1. **Expressive captions (inbound).** Captures audio from any tab (YouTube, Twitch, Google Meet, Zoom Web) or your microphone and draws live captions that *move with the voice*.
   - Whispers are small, thin and faded.
   - Shouts are big and heavy, and they shake.
   - Words lift or sink with pitch, so questions visibly rise.
   - Every finished line gets an on-device **mood** chip, such as 🤩 Excited, 😠 Angry or 😔 Sad.

   The design follows *Caption with Intention*, the award-winning accessibility captioning system from FCB Chicago and the Chicago Hearing Society.
2. **Expressive voice (outbound).** For people who prefer typing to speaking, a slide-out drawer turns a typed reply into emotional speech through **ElevenLabs**. You pick a mood (Excited, Calm, Whisper or Dramatic) and it plays immediately.
3. **Zero data.** No accounts, no servers, no tracking, nothing saved. Audio and text exist only in memory for as long as it takes to process them.

---

## 🚀 How to run it (about 3 minutes)

### What you need
- **Google Chrome 116 or newer**, or another Chromium browser such as Edge, Brave or Arc.
- **An ElevenLabs API key.** Get a free one at [elevenlabs.io](https://elevenlabs.io): click your profile, then **API Keys**, then **Create**. The key needs access to **Text to Speech** and **Speech to Text**.

There's nothing to install or build: no npm, no server, no compile step.

### Step 1: Add your API key
Open **`config.js`** in the project root and replace the placeholder:

```js
ELEVENLABS_API_KEY: 'YOUR_ELEVENLABS_API_KEY',   // ← paste your key here
```

If `config.js` is missing, for example after a fresh clone, create it from the template first:

```bash
cp config.example.js config.js
```

### Step 2: Load the extension into Chrome
1. Go to **`chrome://extensions`**.
2. Turn on **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select this project folder (the one containing `manifest.json`).
4. Pin **ExpressiveLive** from the puzzle-piece menu so its icon stays in the toolbar.

> After changing any file, click the **↻ reload** icon on the ExpressiveLive card in `chrome://extensions`, then **refresh the web page** you're testing on.

### Step 3: Try it out
**See the captions without any audio first:**
1. Open any normal web page, such as `https://www.youtube.com`.
2. Click the ExpressiveLive icon, then **Preview kinetic captions**.
3. A scripted demo plays: a whisper, a question, a shout and a sigh, each with its mood chip.

**Live captions from a video or call:**
1. Open a YouTube video (or a Meet, Twitch or Zoom Web tab) and press play.
2. Click the ExpressiveLive icon, choose **Tab audio**, and click **Start live captions**.
3. Captions appear at the bottom of the page and you still hear the audio normally. The first ~10 words show "calibrating" while the extension learns the speaker's normal volume.
4. Drag the caption box anywhere; double-click it to snap back. Click **Stop** in the popup when done.

**Live captions from your own voice:**
1. In the popup, choose **Microphone**, then **Start live captions**.
2. The first time, a tab opens asking for mic permission. Click **Grant**, close that tab, and click **Start** again.

**Expressive voice:**
1. On any page, press **`Alt+V`** or click the **◉ Voice** pill in the bottom-right corner.
2. Type something, pick a mood, and click **Speak** (or press `Ctrl/⌘+Enter`).

### Troubleshooting

| Problem | Fix |
|---|---|
| "Token request failed (401)" | The API key in `config.js` is wrong or missing. Fix it, then reload the extension. |
| Captions start, then stop with an error right away | Your ElevenLabs plan may not allow zero-retention mode. Set `STT_ZERO_RETENTION: false` in `config.js` and reload. |
| Nothing shows up on the page | Refresh the page after loading or reloading the extension. Chrome's own pages (`chrome://…`, the Web Store) can't be captioned. |
| "Microphone access is needed" | Grant it in the tab that opens. If you blocked it before, go to `chrome://settings/content/microphone` and allow ExpressiveLive. |
| `Alt+V` does nothing | Another extension may own that shortcut. Rebind it at `chrome://extensions/shortcuts`, or click the Voice pill instead. |
| No mood chips | The sentiment model takes about 1 s to load on the first line. Check that `SENTIMENT_ENABLED` is `true` in `config.js`. |
| Something else | On `chrome://extensions`, click **service worker** on the ExpressiveLive card to open its console and look for errors. |

---

## How it works

### Expressive captions
```
popup ──Start──▶ service worker ── tabCapture stream ID + one-time ElevenLabs token ──┐
                                                                                     ▼
                         offscreen document (Web Audio, runs in the background)
                           audio ─┬─▶ speakers (you still hear the tab)
                                  ├─▶ prosody.js: loudness + pitch, measured locally, every 33 ms
                                  └─▶ 16 kHz audio ─▶ ElevenLabs Scribe realtime (speech-to-text)
                           words + timestamps ─▶ style each word by how it was spoken
                           finished line ─▶ sentiment.js (on-device model) ─▶ mood
                                  │
                                  ▼
                         content script ─▶ caption overlay drawn on the page (isolated from site CSS)
```

**What each speech cue looks like:**

| What the voice does | What the caption does |
|---|---|
| Louder than this speaker's normal | Bigger, heavier, wider letters |
| Whispered | Small, light, narrow, slanted, faded; drifts in softly |
| Shouted | Heaviest weight, wide, glowing; slams in and shakes |
| Higher or lower pitch than normal | Word sits higher or lower on the line |
| Pitch rising or falling within a word | Word tilts upward (a question) or sinks (trailing off) |
| A different speaker (when detected) | Different color |
| Timing | Words appear in the rhythm they were spoken |

**Calibration.** Loudness is judged *relative to the speaker's recent words*, not on a fixed scale. A loud YouTube mix and a quiet laptop mic both get the full whisper-to-shout range, and ordinary speech stays ordinary: about 1 word in 7 is styled loud and 1 in 6 as a whisper.

**Mood.** When a line finishes, a small sentiment model (DistilBERT) running *inside the extension* reads whether the words are positive or negative. The voice measurements say how energetic the delivery was. Together they pick a mood: 🤩 Excited, 🙂 Positive, ☺️ Warm, 😠 Angry, 🙁 Negative, 😔 Sad, ❗ Emphatic or 🤫 Quiet. Neutral lines get no chip. So "best day ever" whispered shows as *Warm*, and shouted as *Excited*.

### Expressive voice (ElevenLabs)
Each mood maps to ElevenLabs `voice_settings` and is sent to the streaming text-to-speech endpoint with the `eleven_multilingual_v2` model. Playback begins as soon as the first audio chunk arrives.

| Mood | stability | similarity_boost | style |
|---|---|---|---|
| Excited | 0.30 | 0.85 | 0.70 |
| Calm / Neutral | 0.75 | 0.75 | 0.00 |
| Whisper / Intimate | 0.40 | 0.80 | 0.50 |
| Dramatic / Urgent | 0.20 | 0.90 | 0.80 |

You can change the voice in the drawer under **Voice**; the default is Rachel. If you set `TTS_MODEL_ID: 'eleven_v3'` in `config.js`, each mood also adds an inline audio tag such as `[whispers]`.

ElevenLabs is used for **both directions**: Scribe realtime for the captions and TTS for the voice, with one key.

---

## 🔒 Zero Data guarantees
- **No accounts, no telemetry, no analytics, no cookies, no backend, no database.**
- **Audio** is processed in 100 ms pieces that are sent for transcription and immediately dropped. Nothing is recorded.
- **Transcripts** exist only on screen. Caption lines are deleted from the page after 3.5 s of silence, and nothing is logged.
- **Typed voice text** is cleared from the drawer as soon as it's spoken.
- **Nothing is saved to disk.** The only stored state is whether captions are on and for which tab, kept in memory-only session storage that's wiped when Chrome closes.
- **Sentiment runs fully on-device.** The model ships inside the extension, and downloading or caching models is disabled. Caption text never leaves your browser for this.
- The **only** network destination is `api.elevenlabs.io`, and transcription requests ask ElevenLabs not to retain audio (`enable_logging=false`).

---

## Configuration (`config.js`)

| Setting | Default | What it does |
|---|---|---|
| `ELEVENLABS_API_KEY` | (required) | Your ElevenLabs key. |
| `DEFAULT_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` (Rachel) | Voice used by the drawer. |
| `TTS_MODEL_ID` | `eleven_multilingual_v2` | Set to `eleven_v3` to enable inline mood tags. |
| `STT_MODEL_ID` | `scribe_v2_realtime` | Speech-to-text model. |
| `STT_ZERO_RETENTION` | `true` | Asks ElevenLabs not to keep audio. Set to `false` if your plan rejects it. |
| `SENTIMENT_ENABLED` | `true` | Turns the mood chips on or off. |

> ⚠️ `config.js` is gitignored so your key isn't committed. Anyone you give a packaged copy of the extension to can read the key inside it, so share builds only with a throwaway key.

---

## Project structure
```
manifest.json               Extension manifest (MV3)
config.example.js           Settings template → copy to config.js
background/service_worker.js  Message router, tab capture, ElevenLabs token, TTS requests
offscreen/
  offscreen.js              Audio engine: capture, speech-to-text socket, word styling, TTS playback
  prosody.js                Loudness + pitch tracking and calibration
  sentiment.js              On-device mood detection
  pcm-worklet.js            Converts audio to 16 kHz for speech-to-text
content/
  content.js                Caption overlay, voice drawer, demo
  overlay.css               Kinetic typography and animations
popup/                      Toolbar popup (start/stop, source, size, demo)
permission/                 One-time microphone permission page
styles/                     Bundled Roboto Flex variable font
models/sentiment/           Bundled DistilBERT SST-2 model (quantized ONNX, ~68 MB)
vendor/transformers/        Bundled transformers.js + ONNX runtime (WASM)
```

**Built with:** Chrome Extensions (Manifest V3), Web Audio API, ElevenLabs Scribe realtime and Text-to-Speech, transformers.js, Roboto Flex variable font.

**Credits:** the caption design is inspired by [Caption with Intention](https://lbbonline.com/news/behind-the-oscar-winning-caption-revolution) (FCB Chicago, Chicago Hearing Society and Rakish Entertainment).
