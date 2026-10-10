// Downsamples the input to 16 kHz mono Int16 PCM and posts ~100 ms chunks.
// Buffers are transferred to the main thread and never retained here.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.chunk = new Int16Array(1600); // 100 ms @ 16 kHz
    this.idx = 0;
    this.pos = 0; // fractional read position carried across render quanta
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const ch1 = input[1];
    const n = ch0.length;

    while (this.pos < n) {
      const i = Math.floor(this.pos);
      // Average channels to mono, and average the samples spanned by one step
      // (cheap box-filter anti-aliasing).
      const end = Math.min(n, Math.floor(this.pos + this.ratio));
      let sum = 0, count = 0;
      for (let j = i; j < Math.max(end, i + 1); j++) {
        sum += ch1 ? (ch0[j] + ch1[j]) * 0.5 : ch0[j];
        count++;
      }
      const s = Math.max(-1, Math.min(1, sum / count));
      this.chunk[this.idx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.idx === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(1600);
        this.idx = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= n;
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);
