/* ---------------------------------------------------------------------------
 * Fully synthesized WebAudio sound: no audio assets required.
 *
 *  - Engine: saw + sub-octave square + filtered noise, pitch/gain follow load
 *  - Tracks: band-passed noise with a clank LFO, gain follows ground speed
 *  - Cannon: noise burst with sweeping low-pass + sine "thump"
 *  - MG: short band-passed noise ticks
 *  - Impacts: distance-attenuated low rumble
 *
 * Everything hangs off a compressor → master gain, created lazily on the
 * first user gesture (browser autoplay policy).
 * ------------------------------------------------------------------------ */

import { clamp } from '../utils/math';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuffer!: AudioBuffer;

  // engine chain
  private engineOsc!: OscillatorNode;
  private engineSub!: OscillatorNode;
  private engineGain!: GainNode;
  private engineNoiseGain!: GainNode;
  private engineFilter!: BiquadFilterNode;

  // track chain
  private trackGain!: GainNode;
  private trackLFO!: OscillatorNode;

  muted = false;

  /** Create the graph. Must be called from a user gesture. */
  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // shared white-noise buffer (2 s)
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // ---- engine ----
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 240;
    this.engineFilter.Q.value = 0.8;
    this.engineFilter.connect(this.master);

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.engineFilter);

    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 42;
    this.engineOsc.connect(this.engineGain);
    this.engineOsc.start();

    this.engineSub = ctx.createOscillator();
    this.engineSub.type = 'square';
    this.engineSub.frequency.value = 21;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.engineSub.connect(subGain);
    subGain.connect(this.engineGain);
    this.engineSub.start();

    const engineNoise = ctx.createBufferSource();
    engineNoise.buffer = this.noiseBuffer;
    engineNoise.loop = true;
    this.engineNoiseGain = ctx.createGain();
    this.engineNoiseGain.gain.value = 0;
    engineNoise.connect(this.engineNoiseGain);
    this.engineNoiseGain.connect(this.engineFilter);
    engineNoise.start();

    // ---- tracks ----
    const trackNoise = ctx.createBufferSource();
    trackNoise.buffer = this.noiseBuffer;
    trackNoise.loop = true;
    const trackFilter = ctx.createBiquadFilter();
    trackFilter.type = 'bandpass';
    trackFilter.frequency.value = 820;
    trackFilter.Q.value = 0.9;
    this.trackGain = ctx.createGain();
    this.trackGain.gain.value = 0;
    trackNoise.connect(trackFilter);
    trackFilter.connect(this.trackGain);
    this.trackGain.connect(this.master);
    trackNoise.start();

    // clank rhythm: LFO modulating the track gain
    this.trackLFO = ctx.createOscillator();
    this.trackLFO.type = 'triangle';
    this.trackLFO.frequency.value = 6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.04;
    this.trackLFO.connect(lfoGain);
    lfoGain.connect(this.trackGain.gain);
    this.trackLFO.start();
  }

  /** Per-frame parameter follow. `load` 0..1, `speed` m/s. */
  update(load: number, speed: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpm = 0.25 + load * 0.75;
    const spd = Math.abs(speed);

    this.engineOsc.frequency.setTargetAtTime(38 + rpm * 52, t, 0.12);
    this.engineSub.frequency.setTargetAtTime((38 + rpm * 52) / 2, t, 0.12);
    this.engineFilter.frequency.setTargetAtTime(180 + rpm * 420, t, 0.15);
    this.engineGain.gain.setTargetAtTime(this.muted ? 0 : 0.055 + rpm * 0.075, t, 0.1);
    this.engineNoiseGain.gain.setTargetAtTime(this.muted ? 0 : 0.02 + rpm * 0.05, t, 0.1);

    const trackLevel = this.muted ? 0 : clamp(spd / 11, 0, 1) * 0.16;
    this.trackGain.gain.setTargetAtTime(trackLevel, t, 0.1);
    this.trackLFO.frequency.setTargetAtTime(2 + spd * 1.6, t, 0.2);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  private burst(opts: {
    duration: number;
    gain: number;
    filterType: BiquadFilterType;
    freqStart: number;
    freqEnd?: number;
    q?: number;
  }): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.filterType;
    filter.frequency.setValueAtTime(opts.freqStart, t);
    if (opts.freqEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(30, opts.freqEnd), t + opts.duration);
    }
    filter.Q.value = opts.q ?? 0.7;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + opts.duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + opts.duration + 0.05);
  }

  /** 8.8 cm gun report. */
  playCannon(): void {
    if (!this.ctx || this.muted) return;
    this.burst({ duration: 1.4, gain: 0.95, filterType: 'lowpass', freqStart: 2600, freqEnd: 110 });
    this.burst({ duration: 0.25, gain: 0.5, filterType: 'highpass', freqStart: 900 });

    // sub-bass thump
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(64, t);
    osc.frequency.exponentialRampToValueAtTime(26, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.85, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.6);
  }

  playMG(): void {
    this.burst({ duration: 0.07, gain: 0.3, filterType: 'bandpass', freqStart: 1500, q: 1.2 });
  }

  /** Shell impact heard from `dist` meters away. */
  playImpact(dist: number): void {
    const g = clamp(30 / Math.max(8, dist), 0.04, 0.6);
    this.burst({ duration: 0.9, gain: g, filterType: 'lowpass', freqStart: 900, freqEnd: 90 });
  }

  playReloadDone(): void {
    this.burst({ duration: 0.08, gain: 0.18, filterType: 'bandpass', freqStart: 2400, q: 4 });
    setTimeout(() => {
      this.burst({ duration: 0.06, gain: 0.14, filterType: 'bandpass', freqStart: 3200, q: 4 });
    }, 70);
  }
}
