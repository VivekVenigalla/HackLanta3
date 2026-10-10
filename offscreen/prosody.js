// Prosody tracker: loudness + pitch per audio frame, time-indexed so each
// transcribed word can be styled by how it was actually spoken
// (the "Caption with Intention" idea: size/weight = volume, motion = intonation).
//
// CALIBRATION: a word's loudness is its 80th-percentile dB over its own
// time span, and it is compared against the *same statistic* for the
// speaker's recent words (median ± robust spread). Comparing word peaks to a
// frame average, as the first version did, put almost every word above
// baseline, so everything rendered as "loud". Now about 1 word in 7 counts as
// loud and about 1 in 6 as a whisper, on any source and at any volume.
//
// ZERO DATA: only numbers (time, dB, pitch) are kept, in short ring buffers in
// RAM that are discarded as they age out.

const HISTORY_SEC = 20;
const WORD_HISTORY = 80;          // recent committed words used as the reference
const CALIBRATED_AFTER = 10;      // words needed before levels are trusted
const MIN_SPREAD_DB = 2.5;        // monotone speakers don't turn noise into drama
const Z_TO_LEVEL = 0.17;          // z=+1.3 → loud (0.72), z=-1.2 → whisper (0.3)
const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 500;

export class Prosody {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.frames = [];        // { t, db, speech, semis|null }
    this.wordDbs = [];       // recent committed word loudness (dB)
    this.noiseDb = -60;
    this.basePitch = null;   // running log2(Hz) baseline
    this.smoothDb = -90;
    this.voicedFrames = 0;
  }

  get calibrated() { return this.wordDbs.length >= CALIBRATED_AFTER; }

  /** Feed one analysis frame. `samples` is a Float32 time-domain buffer. */
  push(t, samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
    // Fast attack, slower release, like a VU meter.
    this.smoothDb += (db - this.smoothDb) * (db > this.smoothDb ? 0.6 : 0.25);

    // Track the noise floor (quick down, very slow up).
    this.noiseDb += (db - this.noiseDb) * (db < this.noiseDb ? 0.2 : 0.002);
    const speech = this.smoothDb > Math.max(this.noiseDb + 9, -62);

    let semis = null;
    if (speech) {
      const hz = detectPitch(samples, this.sampleRate);
      if (hz) {
        const lp = Math.log2(hz);
        this.voicedFrames++;
        if (this.basePitch == null) this.basePitch = lp;
        this.basePitch += (lp - this.basePitch) * Math.max(0.02, 1 / this.voicedFrames);
        semis = 12 * (lp - this.basePitch);
      }
    }

    this.frames.push({ t, db: this.smoothDb, speech, semis });
    const cutoff = t - HISTORY_SEC;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
    return { level: speech ? this.meterLevel(this.smoothDb) : 0, isSpeech: speech };
  }

  /** Live meter: position of this frame within recent speech (p10..p95). */
  meterLevel(db) {
    const sp = this.frames.filter((f) => f.speech).map((f) => f.db).sort((a, b) => a - b);
    if (sp.length < 15) return 0.5;
    const lo = quantile(sp, 0.1), hi = quantile(sp, 0.95);
    return clamp01((db - lo) / Math.max(hi - lo, 6));
  }

  /** Word loudness (dB) → 0..1 relative to the speaker's recent words. */
  levelForWord(wordDb) {
    let ref = this.wordDbs;
    if (ref.length < CALIBRATED_AFTER) {
      // Warm-up: approximate word peaks with the 75th percentile of speech frames.
      const sp = this.frames.filter((f) => f.speech).map((f) => f.db).sort((a, b) => a - b);
      if (sp.length < 20) return 0.5;
      const center = quantile(sp, 0.75);
      const spread = Math.max((quantile(sp, 0.9) - quantile(sp, 0.25)) / 1.35, MIN_SPREAD_DB);
      // Halve the swing while uncalibrated so early guesses stay modest.
      return clamp01(0.5 + ((wordDb - center) / spread) * Z_TO_LEVEL * 0.5);
    }
    const sorted = [...ref].sort((a, b) => a - b);
    const median = quantile(sorted, 0.5);
    const mad = quantile(sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b), 0.5);
    const spread = Math.max(mad * 1.4826, MIN_SPREAD_DB);
    return clamp01(0.5 + ((wordDb - median) / spread) * Z_TO_LEVEL);
  }

  /** Add finalized words' loudness to the calibration reference. */
  record(dbs) {
    for (const d of dbs) if (Number.isFinite(d)) this.wordDbs.push(d);
    if (this.wordDbs.length > WORD_HISTORY) this.wordDbs.splice(0, this.wordDbs.length - WORD_HISTORY);
  }

  /** Summarize how the audio between t0 and t1 (seconds) was spoken. */
  window(t0, t1) {
    let fr = this.frames.filter((f) => f.t >= t0 - 0.03 && f.t <= t1 + 0.03);
    if (!fr.length) {
      // Nothing in range: use the nearest frame.
      const mid = (t0 + t1) / 2;
      let best = null;
      for (const f of this.frames) if (!best || Math.abs(f.t - mid) < Math.abs(best.t - mid)) best = f;
      fr = best ? [best] : [];
    }
    if (!fr.length) return { level: 0.5, pitch: 0, slope: 0, db: null };

    // 80th percentile of the word's speech frames: "how hard it was hit".
    const sp = fr.filter((f) => f.speech);
    const dbs = (sp.length ? sp : fr).map((f) => f.db).sort((a, b) => a - b);
    const db = quantile(dbs, 0.8);
    let level = this.levelForWord(db);
    if (!sp.length || db < this.noiseDb + 6) level = Math.min(level, 0.2); // barely above the noise floor

    const voiced = fr.filter((f) => f.semis != null).map((f) => f.semis);
    let pitch = 0, slope = 0;
    if (voiced.length) {
      pitch = voiced.reduce((a, b) => a + b, 0) / voiced.length;
      if (voiced.length >= 3) {
        const k = Math.max(1, Math.floor(voiced.length / 3));
        const head = voiced.slice(0, k).reduce((a, b) => a + b, 0) / k;
        const tail = voiced.slice(-k).reduce((a, b) => a + b, 0) / k;
        slope = tail - head;
      }
    }
    return { level, pitch: clamp(pitch, -12, 12), slope: clamp(slope, -12, 12), db: sp.length ? db : null };
  }

  clear() { this.frames = []; this.wordDbs = []; }
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
}

// YIN-lite pitch detector over the first 1024 samples. Returns Hz or 0.
function detectPitch(buf, sr) {
  const W = Math.min(1024, buf.length >> 1);
  const minLag = Math.floor(sr / PITCH_MAX_HZ);
  const maxLag = Math.min(Math.floor(sr / PITCH_MIN_HZ), buf.length - W - 1);
  if (maxLag <= minLag) return 0;
  const d = new Float32Array(maxLag + 1);
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + tau];
      s += diff * diff;
    }
    running += s;
    d[tau] = running ? (s * tau) / running : 1; // cumulative mean normalized difference
  }
  for (let tau = minLag; tau < maxLag; tau++) {
    if (d[tau] < 0.15) {
      while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++;
      // Parabolic refinement.
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const denom = a + c - 2 * b;
      const shift = denom ? (a - c) / (2 * denom) : 0;
      return sr / (tau + shift);
    }
  }
  return 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => clamp(v, 0, 1);
