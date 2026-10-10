// On-device sentiment for finished caption lines.
//
// Text side: DistilBERT fine-tuned on SST-2 (quantized ONNX, bundled in
// /models/sentiment) running in transformers.js on WASM, entirely inside the
// extension. Voice side: loudness/pitch that prosody.js already measured.
// The two are fused into a valence × arousal mood, e.g. positive words said
// loudly = "excited", negative words said quietly = "sad".
//
// ZERO DATA: no network calls (remote models disabled), no Cache Storage, and
// the caption text is discarded as soon as it's classified.
import { pipeline, env } from '../vendor/transformers/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/');
env.backends.onnx.wasm.numThreads = 1; // offscreen docs aren't cross-origin isolated

let classifier = null;

export function warmUp() {
  classifier ??= pipeline('sentiment-analysis', 'sentiment', { dtype: 'q8', device: 'wasm' })
    .catch((err) => { classifier = null; throw err; });
  return classifier;
}

// SST-2 is binary and overconfident, so anything short of a strong call is neutral.
const NEUTRAL_BELOW = 0.995;

/**
 * @param {string} text  finished caption line
 * @param {{level:number,slope:number}[]} words  per-word prosody
 * @returns {Promise<{mood:string, valence:number, arousal:number}>}
 */
export async function analyze(text, words) {
  const clf = await warmUp();
  const [res] = await clf(text);
  const pPos = res.label === 'POSITIVE' ? res.score : 1 - res.score;
  let valence = 2 * pPos - 1; // -1 … 1
  const wordCount = words.length;
  if (Math.max(pPos, 1 - pPos) < NEUTRAL_BELOW || wordCount < 3) valence *= 0.3;

  // Arousal from the voice: average level, share of loud words, pitch movement.
  const levels = words.map((w) => w.level ?? 0.5);
  const mean = levels.reduce((a, b) => a + b, 0) / Math.max(1, levels.length);
  const loudShare = levels.filter((l) => l > 0.72).length / Math.max(1, levels.length);
  const motion = words.reduce((a, w) => a + Math.min(1, Math.abs(w.slope || 0) / 6), 0) / Math.max(1, wordCount);
  // Centered so ordinary speech (level ≈ 0.5) lands mid-range.
  const arousal = Math.max(0, Math.min(1, 0.5 + 1.2 * (mean - 0.5) + 0.35 * loudShare + 0.2 * motion));

  return { mood: moodFor(valence, arousal), valence, arousal };
}

function moodFor(v, a) {
  const pos = v > 0.4, neg = v < -0.4; // damped (uncertain) scores max out at ±0.3
  const high = a > 0.62, low = a < 0.35;
  if (pos) return high ? 'excited' : low ? 'warm' : 'positive';
  if (neg) return high ? 'angry' : low ? 'sad' : 'negative';
  return high ? 'emphatic' : low ? 'quiet' : 'neutral';
}
