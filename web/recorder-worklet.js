// Captures whatever is fed into it as 16-bit stereo PCM and sends it to the page in chunks.
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.size = 4096; // frames per message
    this.buf = new Int16Array(this.size * 2);
    this.fill = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.on === 'boolean') this.on = d.on;
      if (d.flush) this.flush();
    };
  }
  flush() {
    if (this.fill > 0) {
      this.port.postMessage(this.buf.slice(0, this.fill * 2).buffer);
      this.fill = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    if (this.on && input && input.length) {
      const L = input[0];
      const R = input[1] || input[0];
      for (let i = 0; i < L.length; i++) {
        const l = Math.max(-1, Math.min(1, L[i]));
        const r = Math.max(-1, Math.min(1, R[i]));
        this.buf[this.fill * 2] = l < 0 ? l * 32768 : l * 32767;
        this.buf[this.fill * 2 + 1] = r < 0 ? r * 32768 : r * 32767;
        this.fill++;
        if (this.fill >= this.size) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PcmRecorder);
