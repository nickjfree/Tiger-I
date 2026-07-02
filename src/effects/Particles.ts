/* ---------------------------------------------------------------------------
 * CPU-simulated, GPU-drawn particle system.
 *
 * Two shared pools (normal-blend for smoke/dust/dirt, additive for flashes
 * and tracers), each a single THREE.Points draw call with per-particle
 * position/size/color/alpha attributes. On top of the generic `emit()`,
 * this class provides the game's concrete effects: muzzle blast, exhaust,
 * track dust, shell explosions and MG impacts.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { clamp, lerp } from '../utils/math';

export interface EmitOptions {
  pos: THREE.Vector3;
  posSpread?: number;
  vel: THREE.Vector3;
  velSpread?: number;
  count: number;
  /** [min, max] seconds */
  life: [number, number];
  /** starting size range [min, max] (world meters at 1 m distance scale) */
  size: [number, number];
  /** size multiplier at end of life (1 = constant, >1 grows) */
  sizeEnd?: number;
  color: THREE.ColorRepresentation;
  colorEnd?: THREE.ColorRepresentation;
  alpha?: number;
  /** downward acceleration m/s² (negative = buoyant/rising) */
  gravity?: number;
  /** velocity damping per second (0..1-ish) */
  drag?: number;
  additive?: boolean;
}

const NORMAL_POOL = 2600;
const ADDITIVE_POOL = 1200;

class Pool {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly alphas: Float32Array;
  private readonly sizes: Float32Array;

  // simulation state (structure-of-arrays)
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly sizeEnd: Float32Array;
  private readonly col0: Float32Array;
  private readonly col1: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;

  private cursor = 0;
  private readonly geo: THREE.BufferGeometry;

  constructor(readonly capacity: number, additive: boolean, texture: THREE.Texture) {
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.alphas = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.sizeEnd = new Float32Array(capacity);
    this.col0 = new Float32Array(capacity * 3);
    this.col1 = new Float32Array(capacity * 3);
    this.alpha0 = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: texture } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (300.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha <= 0.003) discard;
          float a = texture2D(map, gl_PointCoord).a;
          gl_FragColor = vec4(vColor, a * vAlpha);
        }
      `,
    });

    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 11;
  }

  spawn(o: Required<Pick<EmitOptions, 'pos' | 'vel'>> & EmitOptions, c0: THREE.Color, c1: THREE.Color): void {
    for (let n = 0; n < o.count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;

      const ps = o.posSpread ?? 0;
      const vs = o.velSpread ?? 0;
      this.positions[i * 3 + 0] = o.pos.x + (Math.random() - 0.5) * 2 * ps;
      this.positions[i * 3 + 1] = o.pos.y + (Math.random() - 0.5) * 2 * ps;
      this.positions[i * 3 + 2] = o.pos.z + (Math.random() - 0.5) * 2 * ps;
      this.vel[i * 3 + 0] = o.vel.x + (Math.random() - 0.5) * 2 * vs;
      this.vel[i * 3 + 1] = o.vel.y + (Math.random() - 0.5) * 2 * vs;
      this.vel[i * 3 + 2] = o.vel.z + (Math.random() - 0.5) * 2 * vs;

      const life = lerp(o.life[0], o.life[1], Math.random());
      this.life[i] = life;
      this.maxLife[i] = life;
      this.size0[i] = lerp(o.size[0], o.size[1], Math.random());
      this.sizeEnd[i] = o.sizeEnd ?? 1;
      this.col0[i * 3 + 0] = c0.r;
      this.col0[i * 3 + 1] = c0.g;
      this.col0[i * 3 + 2] = c0.b;
      this.col1[i * 3 + 0] = c1.r;
      this.col1[i * 3 + 1] = c1.g;
      this.col1[i * 3 + 2] = c1.b;
      this.alpha0[i] = o.alpha ?? 1;
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
    }
  }

  update(dt: number): void {
    const n = this.capacity;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        continue;
      }
      const t = 1 - this.life[i] / this.maxLife[i]; // 0 → 1 over lifetime

      const dragF = 1 - clamp(this.drag[i] * dt, 0, 0.9);
      this.vel[i * 3 + 0] *= dragF;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * dragF - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= dragF;
      this.positions[i * 3 + 0] += this.vel[i * 3 + 0] * dt;
      this.positions[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.vel[i * 3 + 2] * dt;

      this.sizes[i] = this.size0[i] * lerp(1, this.sizeEnd[i], t);
      // quick fade-in, smooth fade-out
      const fade = Math.min(1, t * 8) * (1 - t) * (1 - t) * (2 + t);
      this.alphas[i] = this.alpha0[i] * clamp(fade, 0, 1);
      this.colors[i * 3 + 0] = lerp(this.col0[i * 3 + 0], this.col1[i * 3 + 0], t);
      this.colors[i * 3 + 1] = lerp(this.col0[i * 3 + 1], this.col1[i * 3 + 1], t);
      this.colors[i * 3 + 2] = lerp(this.col0[i * 3 + 2], this.col1[i * 3 + 2], t);
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class Particles {
  private readonly normal: Pool;
  private readonly additive: Pool;
  private readonly cA = new THREE.Color();
  private readonly cB = new THREE.Color();
  private readonly v = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const tex = Particles.makeSoftTexture();
    this.normal = new Pool(NORMAL_POOL, false, tex);
    this.additive = new Pool(ADDITIVE_POOL, true, tex);
    scene.add(this.normal.points, this.additive.points);
  }

  private static makeSoftTexture(): THREE.Texture {
    const s = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = s;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(canvas);
  }

  emit(o: EmitOptions): void {
    this.cA.set(o.color);
    this.cB.set(o.colorEnd ?? o.color);
    (o.additive ? this.additive : this.normal).spawn(o as never, this.cA, this.cB);
  }

  update(dt: number): void {
    this.normal.update(dt);
    this.additive.update(dt);
  }

  /* ------------------------------------------------------------------ */
  /* Concrete game effects                                               */
  /* ------------------------------------------------------------------ */

  /** 88 mm muzzle blast: bright flash + fast cone of smoke + lingering cloud. */
  muzzleBlast(pos: THREE.Vector3, dir: THREE.Vector3): void {
    // flash core
    this.emit({
      pos, vel: this.v.copy(dir).multiplyScalar(8), velSpread: 2,
      count: 10, life: [0.04, 0.1], size: [1.4, 2.6], sizeEnd: 2.4,
      color: 0xffe9b0, colorEnd: 0xff8c30, alpha: 0.95, additive: true,
    });
    // fast forward smoke cone
    this.emit({
      pos, vel: this.v.copy(dir).multiplyScalar(26), velSpread: 5,
      count: 26, life: [0.35, 0.9], size: [0.5, 1.1], sizeEnd: 4.5,
      color: 0xb9ac8f, colorEnd: 0x6e675c, alpha: 0.5, drag: 3.2, gravity: -1.2,
    });
    // side blast rings (muzzle brake vents sideways)
    for (const side of [-1, 1]) {
      const lateral = new THREE.Vector3(-dir.z * side, 0.15, dir.x * side).normalize().multiplyScalar(12);
      this.emit({
        pos, vel: lateral, velSpread: 3,
        count: 8, life: [0.25, 0.6], size: [0.4, 0.9], sizeEnd: 3.5,
        color: 0xcabfa5, colorEnd: 0x71695b, alpha: 0.42, drag: 3.5,
      });
    }
    // lingering cloud drifting up
    this.emit({
      pos: this.v.copy(pos).addScaledVector(dir, 1.5) as THREE.Vector3,
      vel: new THREE.Vector3(0, 1.4, 0), velSpread: 1.2,
      count: 16, life: [1.4, 2.8], size: [0.9, 1.6], sizeEnd: 3.2,
      color: 0x9c9384, colorEnd: 0x565049, alpha: 0.3, drag: 1.2, gravity: -0.4,
    });
  }

  /** Small MG muzzle flash. */
  mgFlash(pos: THREE.Vector3, dir: THREE.Vector3): void {
    this.emit({
      pos, vel: this.v.copy(dir).multiplyScalar(5), velSpread: 1,
      count: 2, life: [0.03, 0.06], size: [0.35, 0.6], sizeEnd: 1.6,
      color: 0xffd88a, colorEnd: 0xff9030, alpha: 0.9, additive: true,
    });
  }

  /** Diesel-ish exhaust puff (called continuously while engine runs). */
  exhaustPuff(pos: THREE.Vector3, load: number): void {
    this.emit({
      pos, posSpread: 0.06,
      vel: new THREE.Vector3(0, 1.1 + load * 2.4, -0.3), velSpread: 0.35,
      count: 1, life: [0.7, 1.6], size: [0.2, 0.35 + load * 0.3], sizeEnd: 4,
      color: load > 0.5 ? 0x3c3a36 : 0x565550, colorEnd: 0x84817a,
      alpha: 0.16 + load * 0.2, drag: 1.4, gravity: -0.5,
    });
  }

  /** Dust kicked up by the tracks. */
  trackDust(pos: THREE.Vector3, backward: THREE.Vector3, intensity: number): void {
    this.emit({
      pos, posSpread: 0.45,
      vel: this.v.copy(backward).multiplyScalar(2.2 + intensity * 2).setY(1.2 + intensity),
      velSpread: 1.1,
      count: 1 + Math.floor(intensity * 2),
      life: [0.8, 2.0], size: [0.5, 1.1], sizeEnd: 3.8,
      color: 0x9a8a68, colorEnd: 0x6f6450,
      alpha: 0.16 + intensity * 0.12, drag: 1.8, gravity: -0.25,
    });
  }

  /** Full HE-style ground explosion: flash, dirt spray, smoke, dust ring. */
  explosion(pos: THREE.Vector3, normal: THREE.Vector3): void {
    // flash
    this.emit({
      pos, vel: this.v.copy(normal).multiplyScalar(3), velSpread: 2,
      count: 14, life: [0.06, 0.16], size: [1.6, 3.2], sizeEnd: 2.6,
      color: 0xfff0b8, colorEnd: 0xff7a20, alpha: 1, additive: true,
    });
    // dirt clods (ballistic, dark)
    this.emit({
      pos, vel: this.v.copy(normal).multiplyScalar(11), velSpread: 6.5,
      count: 30, life: [0.5, 1.3], size: [0.14, 0.4], sizeEnd: 0.7,
      color: 0x4c4030, colorEnd: 0x3a3226, alpha: 0.95, gravity: 16, drag: 0.4,
    });
    // dirt/smoke column
    this.emit({
      pos, vel: this.v.copy(normal).multiplyScalar(7), velSpread: 2.2,
      count: 24, life: [0.9, 2.2], size: [0.9, 1.7], sizeEnd: 3.6,
      color: 0x7d6f56, colorEnd: 0x4f4a42, alpha: 0.55, drag: 1.6, gravity: 0.6,
    });
    // low dust ring
    this.emit({
      pos, posSpread: 0.4,
      vel: new THREE.Vector3(0, 0.7, 0), velSpread: 3.4,
      count: 18, life: [1.2, 2.6], size: [0.8, 1.4], sizeEnd: 4.2,
      color: 0xa39274, colorEnd: 0x6b6252, alpha: 0.28, drag: 2.0, gravity: -0.15,
    });
  }

  /** Small dirt puff for MG bullet impacts. */
  bulletImpact(pos: THREE.Vector3): void {
    this.emit({
      pos, vel: new THREE.Vector3(0, 2.6, 0), velSpread: 1.4,
      count: 4, life: [0.25, 0.6], size: [0.15, 0.35], sizeEnd: 2.4,
      color: 0x8f8064, colorEnd: 0x5f584a, alpha: 0.5, drag: 1.5, gravity: 3,
    });
  }

  /** Faint smoke trail behind a shell. */
  shellTrail(pos: THREE.Vector3): void {
    this.emit({
      pos, posSpread: 0.04,
      vel: new THREE.Vector3(0, 0.25, 0), velSpread: 0.15,
      count: 1, life: [0.3, 0.7], size: [0.12, 0.2], sizeEnd: 3,
      color: 0xbdb4a2, colorEnd: 0x8a847a, alpha: 0.22, drag: 1,
    });
  }
}
