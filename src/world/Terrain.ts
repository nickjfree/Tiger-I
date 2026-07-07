/* ---------------------------------------------------------------------------
 * Procedural battlefield terrain.
 *
 * Heights come from an *analytic* fBm function, so any system (suspension,
 * shells, camera, props) can sample exact heights/normals anywhere without
 * raycasting against the render mesh.
 *
 * The render mesh is a displaced plane with per-vertex colors (dry grass,
 * dirt, mud in depressions) plus a tiling detail texture.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { SimplexNoise2D, mulberry32 } from '../utils/noise';
import { clamp, lerp } from '../utils/math';

export class Terrain {
  /** Total side length of the square terrain, meters. */
  readonly size = 640;
  /** Grid segments per side for the render mesh. */
  readonly segments = 220;

  readonly mesh: THREE.Mesh;
  readonly group = new THREE.Group();

  private readonly noise: SimplexNoise2D;
  /** Shared seeded RNG, also used by Props so layouts stay deterministic. */
  readonly rand: () => number;

  /** Radius around origin that is flattened for the spawn area. */
  private readonly spawnFlatRadius = 22;
  private spawnHeight = 0;

  constructor(seed = 20431) {
    this.noise = new SimplexNoise2D(seed);
    this.rand = mulberry32(seed ^ 0x9e3779b9);

    // Height of the (unflattened) field at the origin, so the flat spawn pad
    // blends into the surroundings.
    this.spawnHeight = this.rawHeight(0, 0);

    if (!Terrain.headless) {
      this.mesh = this.buildMesh();
      this.group.add(this.mesh);
    } else {
      this.mesh = null as unknown as THREE.Mesh; // server never renders
    }
  }

  /** True when running under Node (game server) — no DOM/canvas available. */
  static get headless(): boolean {
    return typeof document === 'undefined';
  }

  /* ------------------------------------------------------------------ */
  /* Height field                                                        */
  /* ------------------------------------------------------------------ */

  /** fBm height before spawn flattening. */
  private rawHeight(x: number, z: number): number {
    const n = this.noise;
    // Large rolling hills
    let h = n.fbm(x * 0.004, z * 0.004, 4, 2.1, 0.5) * 14;
    // Medium undulation
    h += n.fbm(x * 0.02 + 31.7, z * 0.02 - 12.3, 3, 2.0, 0.5) * 2.2;
    // Fine bumps / ruts that make the suspension work
    h += n.noise(x * 0.11, z * 0.11) * 0.35;
    // Gentle bowl so the play area edge rises a bit (keeps player inside)
    const d = Math.hypot(x, z) / (this.size * 0.5);
    h += d * d * 6;
    return h;
  }

  /** Public exact height at world (x, z). */
  getHeight(x: number, z: number): number {
    const h = this.rawHeight(x, z);
    const d = Math.hypot(x, z);
    if (d < this.spawnFlatRadius * 2) {
      // Smoothstep blend from flat pad to natural field
      const t = clamp((d - this.spawnFlatRadius) / this.spawnFlatRadius, 0, 1);
      const s = t * t * (3 - 2 * t);
      return lerp(this.spawnHeight, h, s);
    }
    return h;
  }

  /** Surface normal via central differences. */
  getNormal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.6;
    const hx = this.getHeight(x + e, z) - this.getHeight(x - e, z);
    const hz = this.getHeight(x, z + e) - this.getHeight(x, z - e);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }

  /* ------------------------------------------------------------------ */
  /* Render mesh                                                         */
  /* ------------------------------------------------------------------ */

  private buildMesh(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.segments, this.segments);
    geo.rotateX(-Math.PI / 2); // make it horizontal, +Y up

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.getHeight(x, z);
      pos.setY(i, h);
      this.groundColor(x, z, h, c);
      colors[i * 3 + 0] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: Terrain.headless ? null : this.makeDetailTexture(),
      roughness: 0.96,
      metalness: 0.0,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    return mesh;
  }

  /** Ground albedo used for both vertex colors and the minimap. */
  groundColor(x: number, z: number, h: number, out: THREE.Color): THREE.Color {
    const n = this.noise;
    const patch = n.fbm(x * 0.015 + 100, z * 0.015 - 60, 3) * 0.5 + 0.5; // 0..1 dirt patches
    const micro = n.noise(x * 0.35, z * 0.35) * 0.5 + 0.5;

    // Late-summer battlefield: dry grass base, dirt where "worn", darker mud low
    const grass = out.setRGB(0.42, 0.40, 0.22);
    const dirt = new THREE.Color(0.38, 0.30, 0.20);
    const mud = new THREE.Color(0.24, 0.20, 0.14);

    grass.lerp(dirt, clamp((patch - 0.45) * 2.2, 0, 1));
    // depressions get muddier
    const low = clamp((this.spawnHeight + 2 - h) * 0.18, 0, 0.5);
    grass.lerp(mud, low);
    // micro variation
    grass.multiplyScalar(0.85 + micro * 0.3);
    return grass;
  }

  /** Small tiling grayscale noise texture multiplied over vertex colors. */
  private makeDetailTexture(): THREE.Texture {
    const s = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = s;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(s, s);
    const rand = mulberry32(4242);
    for (let i = 0; i < s * s; i++) {
      const v = 200 + Math.floor(rand() * 55) - 27; // subtle speckle
      img.data[i * 4 + 0] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(90, 90);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

}
