// Pitch shifter for key changes: a streaming phase vocoder (shifts pitch without changing speed).
// Runs inside an AudioWorklet. The same code is loaded by Node for testing.

function makeFFT(N) {
  const levels = Math.round(Math.log2(N));
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
  const cos = new Float64Array(N / 2);
  const sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N);
    sin[i] = Math.sin((2 * Math.PI * i) / N);
  }
  // In-place transform. Forward uses e^(-i...), inverse uses e^(+i...) and is not scaled.
  return function transform(re, im, inverse) {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cos[k];
          const s = inverse ? sin[k] : -sin[k];
          const tre = re[j + half] * c - im[j + half] * s;
          const tim = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  };
}

class PitchShifterChannel {
  constructor(sampleRate, N = 2048, osamp = 4) {
    this.N = N;
    this.osamp = osamp;
    this.hop = N / osamp;
    this.half = N / 2;
    this.sr = sampleRate;
    this.latency = N - this.hop;
    this.rover = this.latency;
    this.inFIFO = new Float32Array(N);
    this.outFIFO = new Float32Array(this.hop);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.lastPhase = new Float64Array(this.half + 1);
    this.sumPhase = new Float64Array(this.half + 1);
    this.outAccum = new Float64Array(N);
    this.anaMagn = new Float64Array(this.half + 1);
    this.anaFreq = new Float64Array(this.half + 1);
    this.synMagn = new Float64Array(this.half + 1);
    this.synFreq = new Float64Array(this.half + 1);
    this.gain = 1; // level tracker: keeps the output as loud as the input
    this.first = true;
    this.window = new Float64Array(N);
    for (let k = 0; k < N; k++) this.window[k] = -0.5 * Math.cos((2 * Math.PI * k) / N) + 0.5;
    this.fft = makeFFT(N);
  }

  _frame(ratio) {
    const { N, half, osamp, hop, sr } = this;
    const freqPerBin = sr / N;
    const expct = (2 * Math.PI * hop) / N;
    const re = this.re;
    const im = this.im;
    for (let k = 0; k < N; k++) {
      re[k] = this.inFIFO[k] * this.window[k];
      im[k] = 0;
    }
    this.fft(re, im, false);

    // Analysis: work out the true frequency of each bin from how its phase moved since the last frame.
    for (let k = 0; k <= half; k++) {
      const real = re[k];
      const imag = im[k];
      const magn = 2 * Math.sqrt(real * real + imag * imag);
      const phase = Math.atan2(imag, real);
      let tmp = phase - this.lastPhase[k];
      this.lastPhase[k] = phase;
      tmp -= k * expct;
      let qpd = Math.trunc(tmp / Math.PI);
      if (qpd >= 0) qpd += qpd & 1;
      else qpd -= qpd & 1;
      tmp -= Math.PI * qpd;
      tmp = (osamp * tmp) / (2 * Math.PI);
      this.anaMagn[k] = magn;
      this.anaFreq[k] = k * freqPerBin + tmp * freqPerBin;
      if (this.first) this.sumPhase[k] = phase;
    }
    this.first = false;

    // Pitch shift: move every bin to its new frequency.
    this.synMagn.fill(0);
    this.synFreq.fill(0);
    for (let k = 0; k <= half; k++) {
      const index = Math.trunc(k * ratio);
      if (index <= half) {
        this.synMagn[index] += this.anaMagn[k];
        this.synFreq[index] = this.anaFreq[k] * ratio;
      }
    }

    // Synthesis: rebuild the phases for the new frequencies.
    for (let k = 0; k <= half; k++) {
      const magn = this.synMagn[k];
      let tmp = this.synFreq[k];
      tmp -= k * freqPerBin;
      tmp /= freqPerBin;
      tmp = (2 * Math.PI * tmp) / osamp;
      tmp += k * expct;
      this.sumPhase[k] = (this.sumPhase[k] + tmp) % (2 * Math.PI);
      const phase = this.sumPhase[k];
      re[k] = magn * Math.cos(phase);
      im[k] = magn * Math.sin(phase);
    }
    for (let k = half + 1; k < N; k++) {
      re[k] = 0;
      im[k] = 0;
    }
    this.fft(re, im, true);

    // Overlap-add the frame into the output.
    const scale = 2 / (half * osamp);
    for (let k = 0; k < N; k++) this.outAccum[k] += this.window[k] * re[k] * scale;
    // The first `hop` samples are now complete. Compare them with the input they came from and
    // nudge the gain so a key change never makes the song louder or quieter.
    let eIn = 1e-9;
    let eOut = 1e-9;
    for (let k = 0; k < hop; k++) {
      eIn += this.inFIFO[k] * this.inFIFO[k];
      eOut += this.outAccum[k] * this.outAccum[k];
    }
    const target = Math.min(2.5, Math.max(0.4, Math.sqrt(eIn / eOut)));
    const prev = this.gain;
    this.gain += (target - this.gain) * 0.3;
    for (let k = 0; k < hop; k++) {
      const g = prev + ((this.gain - prev) * (k + 1)) / hop;
      this.outFIFO[k] = this.outAccum[k] * g;
    }
    this.outAccum.copyWithin(0, hop);
    this.outAccum.fill(0, N - hop);
    for (let k = 0; k < this.latency; k++) this.inFIFO[k] = this.inFIFO[k + hop];
  }

  process(input, output, ratio) {
    for (let i = 0; i < input.length; i++) {
      this.inFIFO[this.rover] = input[i];
      output[i] = this.outFIFO[this.rover - this.latency];
      this.rover++;
      if (this.rover >= this.N) {
        this.rover = this.latency;
        this._frame(ratio);
      }
    }
  }
}

if (typeof registerProcessor === 'function') {
  class PitchShiftProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.ratio = 1;
      this.channels = [new PitchShifterChannel(sampleRate), new PitchShifterChannel(sampleRate)];
      this.port.onmessage = (e) => {
        if (e.data && typeof e.data.ratio === 'number') this.ratio = e.data.ratio;
      };
    }
    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      for (let c = 0; c < output.length; c++) {
        const x = input[c] || input[0];
        if (!x) output[c].fill(0);
        else this.channels[c % 2].process(x, output[c], this.ratio);
      }
      return true;
    }
  }
  registerProcessor('pitch-shifter', PitchShiftProcessor);
}

if (typeof module !== 'undefined') module.exports = { PitchShifterChannel, makeFFT };
