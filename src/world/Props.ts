/* ---------------------------------------------------------------------------
 * World props: dead trees, boulders, bushes, fences and wooden sheds.
 *
 * Unlike simple scenery, these are *game objects*:
 *  - everything is registered in a uniform spatial hash grid for fast queries
 *  - rocks contribute to the ground height field (see Ground.ts), so the
 *    suspension and tracks ride OVER them
 *  - trees & fences can be crushed by the tank or snapped by shells
 *    (they tip over with a weighted fall animation)
 *  - sheds shatter into physical debris pieces
 *  - bushes are soft (cosmetic, drive-through)
 *
 * All placement is seeded/deterministic.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Terrain } from './Terrain';
import { mulberry32 } from '../utils/noise';
import { clamp } from '../utils/math';

const CELL = 10; // spatial grid cell size (m)

export interface Tree {
  x: number; z: number; y: number;
  scale: number; yaw: number;
  state: 0 | 1 | 2; // standing | falling | down
  fallT: number;
  dirX: number; dirZ: number; // horizontal fall direction
}

export interface Rock {
  x: number; z: number; y: number;
  /** dome footprint radius and height above terrain */
  radius: number; height: number;
}

export interface Fence {
  x: number; z: number; y: number; yaw: number;
  state: 0 | 1 | 2;
  fallT: number;
  dirX: number; dirZ: number;
}

interface ShedPiece {
  mesh: THREE.Mesh;
}

export interface Shed {
  group: THREE.Group;
  x: number; z: number; y: number;
  radius: number;
  intact: boolean;
  pieces: ShedPiece[];
}

export class Props {
  readonly group = new THREE.Group();

  readonly trees: Tree[] = [];
  readonly rocks: Rock[] = [];
  readonly fences: Fence[] = [];
  readonly sheds: Shed[] = [];

  private readonly treeGrid = new Map<number, number[]>();
  private readonly rockGrid = new Map<number, number[]>();
  private readonly fenceGrid = new Map<number, number[]>();

  private trunkMesh!: THREE.InstancedMesh;
  private branchMesh!: THREE.InstancedMesh;
  private fenceMesh!: THREE.InstancedMesh;

  private readonly woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3d2e, roughness: 0.95 });
  private readonly plankMat: THREE.MeshStandardMaterial;

  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3();
  private readonly fallAxis = new THREE.Vector3();

  constructor(private readonly terrain: Terrain) {
    // headless (game server): geometry & placement must stay byte-identical
    // to the client, only the canvas texture is skipped
    this.plankMat = new THREE.MeshStandardMaterial({
      map: typeof document === 'undefined' ? null : Props.makePlankTexture(),
      color: typeof document === 'undefined' ? 0x7c6647 : 0xffffff,
      roughness: 0.9,
      metalness: 0,
    });
    this.buildTrees();
    this.buildRocks();
    this.buildBushes();
    this.buildFences();
    this.buildSheds();
  }

  /* ------------------------------------------------------------------ */
  /* grid helpers                                                        */
  /* ------------------------------------------------------------------ */

  private static key(cx: number, cz: number): number {
    return (cx + 512) * 4096 + (cz + 512);
  }

  private static insert(grid: Map<number, number[]>, x: number, z: number, idx: number): void {
    const k = Props.key(Math.floor(x / CELL), Math.floor(z / CELL));
    const arr = grid.get(k);
    if (arr) arr.push(idx);
    else grid.set(k, [idx]);
  }

  /** Collect indices from the 3×3 cell neighborhood around (x, z). */
  private static query(grid: Map<number, number[]>, x: number, z: number, out: number[]): number[] {
    out.length = 0;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const arr = grid.get(Props.key(cx + i, cz + j));
        if (arr) for (const v of arr) out.push(v);
      }
    }
    return out;
  }

  private readonly qbuf: number[] = [];

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  private scatter(count: number, minR: number, cb: (x: number, z: number, r: () => number) => void): void {
    const rand = this.terrain.rand;
    const half = this.terrain.size * 0.5 - 20;
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < count * 25) {
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      if (Math.hypot(x, z) < minR) continue;
      cb(x, z, rand);
      placed++;
    }
  }

  private buildTrees(): void {
    const trunkGeo = new THREE.CylinderGeometry(0.13, 0.3, 7, 7);
    trunkGeo.translate(0, 3.5, 0); // pivot at the base → easy tip-over
    const branchGeo = new THREE.CylinderGeometry(0.05, 0.1, 2.6, 5);
    branchGeo.translate(0, 1.3, 0);
    branchGeo.rotateZ(0.9);
    branchGeo.translate(0, 4.4, 0);

    this.scatter(90, 42, (x, z, rand) => {
      this.trees.push({
        x, z,
        y: this.terrain.getHeight(x, z),
        scale: 0.7 + rand() * 0.9,
        yaw: rand() * Math.PI * 2,
        state: 0, fallT: 0, dirX: 1, dirZ: 0,
      });
    });

    this.trunkMesh = new THREE.InstancedMesh(trunkGeo, this.woodMat, this.trees.length);
    this.branchMesh = new THREE.InstancedMesh(branchGeo, this.woodMat, this.trees.length);
    this.trunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.branchMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.trunkMesh.castShadow = this.branchMesh.castShadow = true;

    this.trees.forEach((t, i) => {
      this.writeTreeMatrix(i);
      Props.insert(this.treeGrid, t.x, t.z, i);
    });
    this.group.add(this.trunkMesh, this.branchMesh);
  }

  private writeTreeMatrix(i: number): void {
    const t = this.trees[i];
    this.tmpQ.setFromEuler(new THREE.Euler(0, t.yaw, 0));
    if (t.state !== 0) {
      // ease-in fall with a small end bounce, rotating around the base
      const e = t.fallT * t.fallT;
      const overshoot = t.fallT > 0.85 ? Math.sin((t.fallT - 0.85) * 30) * 0.03 * (1 - t.fallT) : 0;
      const ang = (Math.PI / 2 - 0.09 + overshoot) * Math.min(1, e);
      // rotate about the horizontal axis perpendicular to the fall direction
      this.fallAxis.set(t.dirZ, 0, -t.dirX).normalize();
      this.tmpQ2.setFromAxisAngle(this.fallAxis, ang);
      this.tmpQ.premultiply(this.tmpQ2);
    }
    this.tmpS.setScalar(t.scale);
    this.tmpM.compose(this.tmpV.set(t.x, t.y, t.z), this.tmpQ, this.tmpS);
    this.trunkMesh.setMatrixAt(i, this.tmpM);
    this.branchMesh.setMatrixAt(i, this.tmpM);
    this.trunkMesh.instanceMatrix.needsUpdate = true;
    this.branchMesh.instanceMatrix.needsUpdate = true;
  }

  private buildRocks(): void {
    const rand = this.terrain.rand;
    const rockGeo = new THREE.IcosahedronGeometry(0.8, 1);
    const rp = rockGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      rp.setXYZ(
        i,
        rp.getX(i) * (0.8 + rand() * 0.4),
        rp.getY(i) * (0.5 + rand() * 0.3),
        rp.getZ(i) * (0.8 + rand() * 0.4),
      );
    }
    rockGeo.computeVertexNormals();
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x6e6a60, roughness: 0.9 });

    const matrices: THREE.Matrix4[] = [];
    this.scatter(150, 26, (x, z, r) => {
      const s = 0.7 + r() * 1.1;
      const y = this.terrain.getHeight(x, z);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * Math.PI * 2, 0)),
        new THREE.Vector3(s, s, s),
      );
      matrices.push(m);
      this.rocks.push({
        x, z, y,
        radius: 0.78 * s, // dome footprint ≈ geometry xz extent
        height: 0.5 * s, // visible dome height above terrain
      });
    });

    const mesh = new THREE.InstancedMesh(rockGeo, rockMat, matrices.length);
    matrices.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      Props.insert(this.rockGrid, this.rocks[i].x, this.rocks[i].z, i);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildBushes(): void {
    const bushGeo = new THREE.IcosahedronGeometry(0.9, 1);
    bushGeo.scale(1, 0.55, 1);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x3d4423, roughness: 1 });
    const matrices: THREE.Matrix4[] = [];
    this.scatter(200, 24, (x, z, r) => {
      const s = 0.7 + r() * 0.9;
      matrices.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, this.terrain.getHeight(x, z), z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, r() * Math.PI * 2, 0)),
          new THREE.Vector3(s, s, s),
        ),
      );
    });
    const mesh = new THREE.InstancedMesh(bushGeo, bushMat, matrices.length);
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  private static makePlankTexture(): THREE.Texture {
    const s = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = s;
    const ctx = canvas.getContext('2d')!;
    const rand = mulberry32(909);
    ctx.fillStyle = '#7c6647';
    ctx.fillRect(0, 0, s, s);
    // vertical planks with grain
    for (let x = 0; x < s; x += 32) {
      const shade = 0.85 + rand() * 0.3;
      ctx.fillStyle = `rgb(${(124 * shade) | 0},${(102 * shade) | 0},${(71 * shade) | 0})`;
      ctx.fillRect(x, 0, 30, s);
      ctx.fillStyle = 'rgba(40,30,18,0.5)';
      ctx.fillRect(x + 30, 0, 2, s);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = `rgba(60,45,26,${0.12 + rand() * 0.15})`;
        ctx.fillRect(x + 3 + rand() * 24, 0, 1.2, s);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /** One fence segment: post + two rails, pivot at the post base. */
  private buildFences(): void {
    const post = new THREE.BoxGeometry(0.1, 1.1, 0.1);
    post.translate(0, 0.55, 0);
    const rail1 = new THREE.BoxGeometry(0.06, 0.12, 2.0);
    rail1.translate(0, 0.85, 1.0);
    const rail2 = rail1.clone();
    rail2.translate(0, -0.4, 0);
    const geos = [post, rail1, rail2];
    // lazy merge without the utils import: fences are low-poly enough to group
    const merged = new THREE.BufferGeometry();
    {
      // manual merge (all non-indexed after toNonIndexed)
      const parts = geos.map((g) => g.toNonIndexed());
      let total = 0;
      for (const p of parts) total += p.attributes.position.count;
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      const uv = new Float32Array(total * 2);
      let o = 0;
      for (const p of parts) {
        pos.set(p.attributes.position.array as Float32Array, o * 3);
        nor.set(p.attributes.normal.array as Float32Array, o * 3);
        uv.set(p.attributes.uv.array as Float32Array, o * 2);
        o += p.attributes.position.count;
      }
      merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }

    // fence lines: a few random field boundaries
    const rand = this.terrain.rand;
    const lines = 7;
    for (let l = 0; l < lines; l++) {
      const ang = rand() * Math.PI * 2;
      const dist = 70 + rand() * 200;
      let px = Math.sin(ang) * dist;
      let pz = Math.cos(ang) * dist;
      let dir = rand() * Math.PI * 2;
      const n = 5 + Math.floor(rand() * 6);
      for (let i = 0; i < n; i++) {
        this.fences.push({
          x: px, z: pz, y: this.terrain.getHeight(px, pz),
          yaw: dir, state: 0, fallT: 0, dirX: 0, dirZ: 1,
        });
        dir += (rand() - 0.5) * 0.5;
        px += Math.sin(dir) * 2.0;
        pz += Math.cos(dir) * 2.0;
      }
    }

    this.fenceMesh = new THREE.InstancedMesh(merged, this.plankMat, this.fences.length);
    this.fenceMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fenceMesh.castShadow = true;
    this.fences.forEach((f, i) => {
      this.writeFenceMatrix(i);
      Props.insert(this.fenceGrid, f.x, f.z, i);
    });
    this.group.add(this.fenceMesh);
  }

  private writeFenceMatrix(i: number): void {
    const f = this.fences[i];
    this.tmpQ.setFromEuler(new THREE.Euler(0, f.yaw, 0));
    if (f.state !== 0) {
      const e = f.fallT * f.fallT;
      this.fallAxis.set(f.dirZ, 0, -f.dirX).normalize();
      this.tmpQ2.setFromAxisAngle(this.fallAxis, (Math.PI / 2 - 0.12) * Math.min(1, e));
      this.tmpQ.premultiply(this.tmpQ2);
    }
    this.tmpM.compose(this.tmpV.set(f.x, f.y + (f.state === 2 ? 0.02 : 0), f.z), this.tmpQ, this.tmpS.setScalar(1));
    this.fenceMesh.setMatrixAt(i, this.tmpM);
    this.fenceMesh.instanceMatrix.needsUpdate = true;
  }

  private buildSheds(): void {
    const rand = this.terrain.rand;
    const spots: Array<[number, number]> = [];
    let guard = 0;
    while (spots.length < 6 && guard++ < 200) {
      const ang = rand() * Math.PI * 2;
      const d = 60 + rand() * 210;
      const x = Math.sin(ang) * d;
      const z = Math.cos(ang) * d;
      if (spots.every(([sx, sz]) => Math.hypot(x - sx, z - sz) > 40)) spots.push([x, z]);
    }

    for (const [x, z] of spots) {
      const y = this.terrain.getHeight(x, z);
      const w = 3.2 + rand() * 1.2; // width (x)
      const d = 2.6 + rand() * 1.0; // depth (z)
      const h = 2.1 + rand() * 0.5; // wall height

      const group = new THREE.Group();
      group.position.set(x, y, z);
      group.rotation.y = rand() * Math.PI * 2;

      const pieces: ShedPiece[] = [];
      const addPiece = (geo: THREE.BoxGeometry, px: number, py: number, pz: number, ry = 0, rz = 0): void => {
        const mesh = new THREE.Mesh(geo, this.plankMat);
        mesh.position.set(px, py, pz);
        mesh.rotation.set(0, ry, rz);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        pieces.push({ mesh });
      };

      // walls, split into panels so they break apart believably
      for (const side of [-1, 1]) {
        // front/back walls (2 panels each)
        addPiece(new THREE.BoxGeometry(w / 2, h, 0.07), -w / 4, h / 2, (side * d) / 2);
        addPiece(new THREE.BoxGeometry(w / 2, h, 0.07), w / 4, h / 2, (side * d) / 2);
        // side walls
        addPiece(new THREE.BoxGeometry(0.07, h, d / 2), (side * w) / 2, h / 2, -d / 4);
        addPiece(new THREE.BoxGeometry(0.07, h, d / 2), (side * w) / 2, h / 2, d / 4);
      }
      // gable roof: two slanted panels
      const roofLen = Math.hypot(w / 2, 0.8) + 0.25;
      for (const side of [-1, 1]) {
        addPiece(
          new THREE.BoxGeometry(roofLen, 0.06, d + 0.5),
          (side * w) / 4, h + 0.38, 0,
          0, side * -Math.atan2(0.8, w / 2),
        );
      }

      this.group.add(group);
      this.sheds.push({ group, x, z, y, radius: Math.hypot(w, d) / 2 + 0.4, intact: true, pieces });
    }
  }

  /* ------------------------------------------------------------------ */
  /* queries used by Ground / physics / projectiles                      */
  /* ------------------------------------------------------------------ */

  /** Absolute Y of the highest rock surface at (x, z), or -Infinity if none. */
  rockBumpAt(x: number, z: number): number {
    const idxs = Props.query(this.rockGrid, x, z, this.qbuf);
    let bump = -Infinity;
    for (const i of idxs) {
      const r = this.rocks[i];
      const dx = x - r.x;
      const dz = z - r.z;
      const d2 = dx * dx + dz * dz;
      const R2 = r.radius * r.radius;
      if (d2 >= R2) continue;
      // ellipsoidal dome profile above the rock's base terrain height
      const h = r.height * Math.sqrt(1 - d2 / R2);
      bump = Math.max(bump, r.y + h);
    }
    return bump;
  }

  /** Standing trees near a point (for tank crushing). Returns indices. */
  standingTreesNear(x: number, z: number): number[] {
    const idxs = Props.query(this.treeGrid, x, z, this.qbuf);
    return idxs.filter((i) => this.trees[i].state === 0);
  }

  standingFencesNear(x: number, z: number): number[] {
    const idxs = Props.query(this.fenceGrid, x, z, this.qbuf);
    return idxs.filter((i) => this.fences[i].state === 0);
  }

  /** Knock a tree over in the given horizontal direction. */
  fellTree(i: number, dirX: number, dirZ: number): void {
    const t = this.trees[i];
    if (t.state !== 0) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    t.dirX = dirX / len;
    t.dirZ = dirZ / len;
    t.state = 1;
  }

  breakFence(i: number, dirX: number, dirZ: number): void {
    const f = this.fences[i];
    if (f.state !== 0) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    f.dirX = dirX / len;
    f.dirZ = dirZ / len;
    f.state = 1;
  }

  /**
   * Shell segment vs trees/fences/sheds.
   * Returns hit info or null; the caller decides what breaks.
   */
  hitSegment(a: THREE.Vector3, b: THREE.Vector3):
    | { kind: 'tree' | 'fence' | 'shed'; index: number; point: THREE.Vector3 }
    | null {
    // walk the segment in ~2 m steps and use grid queries at each sample
    const dist = a.distanceTo(b);
    const steps = Math.max(1, Math.ceil(dist / 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;

      for (const i of Props.query(this.treeGrid, x, z, this.qbuf)) {
        const tr = this.trees[i];
        if (tr.state !== 0) continue;
        const dx = x - tr.x;
        const dz = z - tr.z;
        if (dx * dx + dz * dz < 0.35 * 0.35 * tr.scale * tr.scale &&
            y > tr.y && y < tr.y + 7 * tr.scale) {
          return { kind: 'tree', index: i, point: new THREE.Vector3(x, y, z) };
        }
      }
      for (const i of Props.query(this.fenceGrid, x, z, this.qbuf)) {
        const f = this.fences[i];
        if (f.state !== 0) continue;
        const dx = x - (f.x + Math.sin(f.yaw));
        const dz = z - (f.z + Math.cos(f.yaw));
        if (dx * dx + dz * dz < 1.3 * 1.3 && y > f.y && y < f.y + 1.2) {
          return { kind: 'fence', index: i, point: new THREE.Vector3(x, y, z) };
        }
      }
      for (let i = 0; i < this.sheds.length; i++) {
        const sh = this.sheds[i];
        if (!sh.intact) continue;
        const dx = x - sh.x;
        const dz = z - sh.z;
        if (dx * dx + dz * dz < sh.radius * sh.radius && y > sh.y && y < sh.y + 3.2) {
          return { kind: 'shed', index: i, point: new THREE.Vector3(x, y, z) };
        }
      }
    }
    return null;
  }

  /**
   * Detach a shed into world-space pieces (caller feeds them to Debris).
   * Returns the pieces with suggested velocities.
   */
  shatterShed(
    index: number,
    blast: THREE.Vector3,
    power: number,
  ): Array<{ mesh: THREE.Mesh; vel: THREE.Vector3 }> {
    const shed = this.sheds[index];
    if (!shed.intact) return [];
    shed.intact = false;

    const out: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3 }> = [];
    for (const piece of shed.pieces) {
      const mesh = piece.mesh;
      // re-parent to world space, keeping the transform
      mesh.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      const ws = new THREE.Vector3();
      mesh.matrixWorld.decompose(wp, wq, ws);
      shed.group.remove(mesh);
      mesh.position.copy(wp);
      mesh.quaternion.copy(wq);
      mesh.scale.copy(ws);

      const dir = wp.clone().sub(blast);
      const d = Math.max(0.8, dir.length());
      dir.normalize();
      const speed = clamp(power / d, 1.5, 11);
      const vel = dir.multiplyScalar(speed);
      vel.y = Math.abs(vel.y) + 2 + Math.random() * 3.5;
      out.push({ mesh, vel });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      if (t.state === 1) {
        t.fallT = Math.min(1, t.fallT + dt * 0.85);
        this.writeTreeMatrix(i);
        if (t.fallT >= 1) t.state = 2;
      }
    }
    for (let i = 0; i < this.fences.length; i++) {
      const f = this.fences[i];
      if (f.state === 1) {
        f.fallT = Math.min(1, f.fallT + dt * 1.5);
        this.writeFenceMatrix(i);
        if (f.fallT >= 1) f.state = 2;
      }
    }
  }
}
