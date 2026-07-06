/* ---------------------------------------------------------------------------
 * Fully synthesized WebAudio sound — no audio assets.
 *
 *  - Player engine: saw + sub-octave + filtered noise. Profile-driven:
 *    Maybach HL230 petrol (higher, smoother snarl) vs V-2 diesel (low,
 *    knocking rumble with heavy sub).
 *  - Enemy engine: an independent simplified loop, gain follows distance.
 *  - Guns: per-profile reports ('kwk36' heavier, 'zis53' sharper), plus
 *    ricochet clang and penetration thump. All 3D-ish: attenuated by
 *    distance from the listener (camera).
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { clamp } from '../utils/math';
import { EngineAudioSpec } from '../tank/config';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuffer!: AudioBuffer;

  // player engine chain
  private engineOsc!: OscillatorNode;
  private engineSub!: OscillatorNode;
  private subGain!: GainNode;
  private engineGain!: GainNode;
  private engineNoiseGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private playerProfile: EngineAudioSpec = { baseFreq: 42, diesel: false };

  // enemy engine chain (lazy)
  private enemyOsc: OscillatorNode | null = null;
  private enemySub: OscillatorNode | null = null;
  private enemyGain: GainNode | null = null;
  private enemyProfile: EngineAudioSpec = { baseFreq: 30, diesel: true };

  // track noise chain
  private trackGain!: GainNode;
  private trackLFO!: OscillatorNode;

  /** Listener position (camera), for distance attenuation. */
  readonly listener = new THREE.Vector3();

  muted = false;

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

    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // ---- player engine ----
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
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.5;
    this.engineSub.connect(this.subGain);
    this.subGain.connect(this.engineGain);
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

    this.trackLFO = ctx.createOscillator();
    this.trackLFO.type = 'triangle';
    this.trackLFO.frequency.value = 6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.04;
    this.trackLFO.connect(lfoGain);
    lfoGain.connect(this.trackGain.gain);
    this.trackLFO.start();
  }

  /** Set the player's engine character (call after start()). */
  configurePlayerEngine(profile: EngineAudioSpec): void {
    this.playerProfile = profile;
    if (!this.ctx) return;
    // diesel: heavier sub-octave knock, tighter filter
    this.subGain.gain.value = profile.diesel ? 0.95 : 0.5;
    this.engineFilter.Q.value = profile.diesel ? 1.4 : 0.8;
  }

  /** Create/replace the distant enemy engine loop. */
  configureEnemyEngine(profile: EngineAudioSpec): void {
    this.enemyProfile = profile;
    if (!this.ctx || this.enemyOsc) return;
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    this.enemyGain = ctx.createGain();
    this.enemyGain.gain.value = 0;
    filter.connect(this.enemyGain);
    this.enemyGain.connect(this.master);

    this.enemyOsc = ctx.createOscillator();
    this.enemyOsc.type = 'sawtooth';
    this.enemyOsc.frequency.value = profile.baseFreq;
    this.enemyOsc.connect(filter);
    this.enemyOsc.start();

    this.enemySub = ctx.createOscillator();
    this.enemySub.type = 'square';
    this.enemySub.frequency.value = profile.baseFreq / 2;
    const sg = ctx.createGain();
    sg.gain.value = profile.diesel ? 0.9 : 0.5;
    this.enemySub.connect(sg);
    sg.connect(filter);
    this.enemySub.start();
  }

  /** Per-frame follow of the player's drivetrain. */
  update(load: number, speed: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const p = this.playerProfile;
    const rpm = 0.25 + load * 0.75;
    const spd = Math.abs(speed);

    const f = p.baseFreq * (1 + rpm * 1.2);
    this.engineOsc.frequency.setTargetAtTime(f, t, 0.12);
    this.engineSub.frequency.setTargetAtTime(f / 2, t, 0.12);
    this.engineFilter.frequency.setTargetAtTime(
      (p.diesel ? 150 : 180) + rpm * (p.diesel ? 320 : 420), t, 0.15,
    );
    this.engineGain.gain.setTargetAtTime(this.muted ? 0 : 0.055 + rpm * 0.075, t, 0.1);
    this.engineNoiseGain.gain.setTargetAtTime(
      this.muted ? 0 : (p.diesel ? 0.03 : 0.02) + rpm * 0.05, t, 0.1,
    );

    const trackLevel = this.muted ? 0 : clamp(spd / 11, 0, 1) * 0.16;
    this.trackGain.gain.setTargetAtTime(trackLevel, t, 0.1);
    this.trackLFO.frequency.setTargetAtTime(2 + spd * 1.6, t, 0.2);
  }

  /** Per-frame follow of the enemy tank (distance-attenuated). */
  updateEnemy(dist: number, load: number, alive: boolean): void {
    if (!this.ctx || !this.enemyOsc || !this.enemyGain || !this.enemySub) return;
    const t = this.ctx.currentTime;
    const p = this.enemyProfile;
    const rpm = 0.25 + load * 0.75;
    const f = p.baseFreq * (1 + rpm * 1.2);
    this.enemyOsc.frequency.setTargetAtTime(f, t, 0.15);
    this.enemySub.frequency.setTargetAtTime(f / 2, t, 0.15);
    const att = alive ? clamp(30 / Math.max(12, dist), 0, 1) : 0;
    this.enemyGain.gain.setTargetAtTime(this.muted ? 0 : att * (0.05 + rpm * 0.08), t, 0.15);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  private attenuation(pos?: THREE.Vector3): number {
    if (!pos) return 1;
    const d = pos.distanceTo(this.listener);
    return clamp(34 / Math.max(10, d), 0.06, 1);
  }

  private burst(opts: {
    duration: number;
    gain: number;
    filterType: BiquadFilterType;
    freqStart: number;
    freqEnd?: number;
    q?: number;
  }): void {
    if (!this.ctx || this.muted || opts.gain < 0.01) return;
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

  /** Main gun report — profile per weapon, attenuated by distance. */
  playCannon(sound: 'kwk36' | 'zis53', pos?: THREE.Vector3): void {
    if (!this.ctx || this.muted) return;
    const a = this.attenuation(pos);

    if (sound === 'kwk36') {
      // 8.8 cm: deep, long boom
      this.burst({ duration: 1.4, gain: 0.95 * a, filterType: 'lowpass', freqStart: 2600, freqEnd: 110 });
      this.burst({ duration: 0.25, gain: 0.5 * a, filterType: 'highpass', freqStart: 900 });
      this.thump(64, 26, 0.55, 0.85 * a);
    } else {
      // 85 mm: sharper crack, slightly shorter
      this.burst({ duration: 1.0, gain: 0.85 * a, filterType: 'lowpass', freqStart: 3200, freqEnd: 150 });
      this.burst({ duration: 0.18, gain: 0.55 * a, filterType: 'highpass', freqStart: 1300 });
      this.thump(76, 32, 0.4, 0.7 * a);
    }
  }

  private thump(f0: number, f1: number, dur: number, gain: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.05);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }

  playMG(pos?: THREE.Vector3): void {
    this.burst({
      duration: 0.07,
      gain: 0.3 * this.attenuation(pos),
      filterType: 'bandpass',
      freqStart: 1500,
      q: 1.2,
    });
  }

  /** Shell impact heard from a distance. */
  playImpact(dist: number): void {
    const g = clamp(30 / Math.max(8, dist), 0.04, 0.6);
    this.burst({ duration: 0.9, gain: g, filterType: 'lowpass', freqStart: 900, freqEnd: 90 });
  }

  /** Armor ricochet: high metallic clang. */
  playRicochet(pos?: THREE.Vector3): void {
    const a = this.attenuation(pos);
    this.burst({ duration: 0.12, gain: 0.5 * a, filterType: 'bandpass', freqStart: 4200, q: 6 });
    this.burst({ duration: 0.3, gain: 0.3 * a, filterType: 'bandpass', freqStart: 2400, q: 3 });
  }

  /** Armor penetration: dull thump + interior clank. */
  playPenetration(pos?: THREE.Vector3): void {
    const a = this.attenuation(pos);
    this.burst({ duration: 0.5, gain: 0.7 * a, filterType: 'lowpass', freqStart: 700, freqEnd: 90 });
    this.burst({ duration: 0.2, gain: 0.45 * a, filterType: 'bandpass', freqStart: 1300, q: 2 });
  }

  playWoodCrack(dist: number): void {
    const g = clamp(18 / Math.max(6, dist), 0.08, 0.5);
    this.burst({ duration: 0.16, gain: g, filterType: 'lowpass', freqStart: 900, freqEnd: 200 });
    this.burst({ duration: 0.05, gain: g * 0.8, filterType: 'bandpass', freqStart: 2600, q: 2.5 });
  }

  playCrash(dist: number): void {
    const g = clamp(26 / Math.max(6, dist), 0.1, 0.65);
    this.burst({ duration: 0.8, gain: g, filterType: 'lowpass', freqStart: 700, freqEnd: 100 });
    this.burst({ duration: 0.25, gain: g * 0.7, filterType: 'bandpass', freqStart: 1800, q: 1.5 });
    this.burst({ duration: 0.12, gain: g * 0.5, filterType: 'bandpass', freqStart: 3200, q: 3 });
  }

  /** Big kill explosion. */
  playExplosion(pos?: THREE.Vector3): void {
    const a = this.attenuation(pos);
    this.burst({ duration: 2.0, gain: 0.95 * a, filterType: 'lowpass', freqStart: 1800, freqEnd: 70 });
    this.thump(52, 22, 0.9, 0.9 * a);
  }

  playReloadDone(): void {
    this.burst({ duration: 0.08, gain: 0.18, filterType: 'bandpass', freqStart: 2400, q: 4 });
    setTimeout(() => {
      this.burst({ duration: 0.06, gain: 0.14, filterType: 'bandpass', freqStart: 3200, q: 4 });
    }, 70);
  }
}
