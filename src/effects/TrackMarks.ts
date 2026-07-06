/* ---------------------------------------------------------------------------
 * Track imprints left on the ground.
 *
 * Each track lays a ribbon of terrain-conforming quads behind it (ring buffer
 * per side). A repeating cleat-bar alpha texture makes them read as actual
 * Kgs 63 link imprints, and each quad fades out with age. Pivot turns work
 * naturally because stamping is driven by each track's own contact point
 * motion, not hull speed.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { GroundLike } from '../world/Ground';
import { clamp } from '../utils/math';

const QUADS = 900; // per side ≈ 300 m of trail
const STAMP_DIST = 0.34; // m between stamps
const BASE_ALPHA = 0.5;
const FADE_START = 240; // s — imprints in soft ground linger
const FADE_LEN = 90; // s

class Ribbon {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly uv: Float32Array;
  private readonly alpha: Float32Array;
  private readonly birth: Float32Array; // per quad
  private readonly geo: THREE.BufferGeometry;

  private head = 0;
  private used = 0;
  private lastL: THREE.Vector3 | null = null;
  private lastR: THREE.Vector3 | null = null;
  private vCoord = 0;
  private readonly eL = new THREE.Vector3();
  private readonly eR = new THREE.Vector3();

  constructor(
    material: THREE.Material,
    private readonly ground: GroundLike,
    private readonly trackWidth: number,
    private readonly linkPitch: number,
  ) {
    this.pos = new Float32Array(QUADS * 4 * 3);
    this.uv = new Float32Array(QUADS * 4 * 2);
    this.alpha = new Float32Array(QUADS * 4);
    this.birth = new Float32Array(QUADS);

    const index = new Uint32Array(QUADS * 6);
    for (let q = 0; q < QUADS; q++) {
      const v = q * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.drawRange.count = 0;

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.receiveShadow = false;
  }

  /** Break ribbon continuity (track left the ground). */
  lift(): void {
    this.lastL = null;
    this.lastR = null;
  }

  stamp(center: THREE.Vector3, right: THREE.Vector3, now: number): void {
    const halfW = this.trackWidth / 2;
    this.eL.copy(center).addScaledVector(right, -halfW);
    this.eR.copy(center).addScaledVector(right, halfW);
    this.eL.y = this.ground.getHeight(this.eL.x, this.eL.z) + 0.03;
    this.eR.y = this.ground.getHeight(this.eR.x, this.eR.z) + 0.03;

    if (!this.lastL || !this.lastR) {
      this.lastL = this.eL.clone();
      this.lastR = this.eR.clone();
      return;
    }
    const moved = (this.eL.distanceTo(this.lastL) + this.eR.distanceTo(this.lastR)) / 2;
    if (moved < STAMP_DIST) return;
    if (moved > 3) {
      // discontinuity (reset/teleport) — restart the ribbon instead of
      // drawing one giant smear across the map
      this.lastL.copy(this.eL);
      this.lastR.copy(this.eR);
      return;
    }

    const q = this.head;
    this.head = (this.head + 1) % QUADS;
    this.used = Math.min(this.used + 1, QUADS);
    this.geo.drawRange.count = this.used * 6;

    const base = q * 12;
    this.pos.set(
      [
        this.lastL.x, this.lastL.y, this.lastL.z,
        this.lastR.x, this.lastR.y, this.lastR.z,
        this.eL.x, this.eL.y, this.eL.z,
        this.eR.x, this.eR.y, this.eR.z,
      ],
      base,
    );
    const v0 = this.vCoord;
    this.vCoord += moved / this.linkPitch; // one cleat per track-link pitch
    const ub = q * 8;
    this.uv.set([0, v0, 1, v0, 0, this.vCoord, 1, this.vCoord], ub);
    this.birth[q] = now;
    this.alpha.fill(BASE_ALPHA, q * 4, q * 4 + 4);

    this.lastL.copy(this.eL);
    this.lastR.copy(this.eR);

    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.uv as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Refresh age-based fading (called at ~10 Hz). */
  refade(now: number): void {
    let dirty = false;
    for (let q = 0; q < this.used; q++) {
      const age = now - this.birth[q];
      if (age < FADE_START) continue;
      const a = BASE_ALPHA * clamp(1 - (age - FADE_START) / FADE_LEN, 0, 1);
      if (Math.abs(this.alpha[q * 4] - a) > 0.01) {
        this.alpha.fill(a, q * 4, q * 4 + 4);
        dirty = true;
      }
    }
    if (dirty) (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class TrackMarks {
  private readonly left: Ribbon;
  private readonly right: Ribbon;
  private time = 0;
  private refadeAcc = 0;

  constructor(scene: THREE.Scene, ground: GroundLike, trackWidth = 0.725, linkPitch = 0.13) {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: {
        map: { value: TrackMarks.makeCleatTexture() },
        color: { value: new THREE.Color(0x261f15) },
      },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vAlpha = aAlpha;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 color;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          float a = texture2D(map, vUv).a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(color, a);
        }
      `,
    });

    this.left = new Ribbon(material, ground, trackWidth, linkPitch);
    this.right = new Ribbon(material, ground, trackWidth, linkPitch);
    scene.add(this.left.mesh, this.right.mesh);
  }

  private static makeCleatTexture(): THREE.Texture {
    const w = 64;
    const h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    // transverse cleat bar (strong) + between-bar shading (weak)
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(3, 0, w - 6, h);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillRect(2, h * 0.32, w - 4, h * 0.36);
    // soft edges
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.12, 'rgba(0,0,0,0)');
    grad.addColorStop(0.88, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /**
   * @param onGroundL/R whether each track currently touches the ground
   * @param centerL/R   world-space point under each track's center
   * @param right       hull right axis (horizontal)
   */
  update(
    dt: number,
    onGroundL: boolean, centerL: THREE.Vector3,
    onGroundR: boolean, centerR: THREE.Vector3,
    right: THREE.Vector3,
  ): void {
    this.time += dt;
    if (onGroundL) this.left.stamp(centerL, right, this.time);
    else this.left.lift();
    if (onGroundR) this.right.stamp(centerR, right, this.time);
    else this.right.lift();

    this.refadeAcc += dt;
    if (this.refadeAcc > 0.1) {
      this.refadeAcc = 0;
      this.left.refade(this.time);
      this.right.refade(this.time);
    }
  }
}
