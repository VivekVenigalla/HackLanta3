// Copy this file to config.js and fill in your key. config.js is gitignored.
// The key is only ever sent to api.elevenlabs.io.
export const CONFIG = {
  ELEVENLABS_API_KEY: 'YOUR_ELEVENLABS_API_KEY',
  DEFAULT_VOICE_ID: '21m00Tcm4TlvDq8ikWAM', // Rachel
  TTS_MODEL_ID: 'eleven_multilingual_v2',
  STT_MODEL_ID: 'scribe_v2_realtime',
  // Ask ElevenLabs not to log/retain STT audio (zero-retention mode).
  // Some plans reject this; set to false if the STT socket errors on connect.
  STT_ZERO_RETENTION: true,
  // On-device sentiment for caption lines (bundled model, never leaves the browser).
  SENTIMENT_ENABLED: true,
};
