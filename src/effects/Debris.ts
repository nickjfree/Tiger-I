/* ---------------------------------------------------------------------------
 * Lightweight debris physics for destructible structures.
 *
 * Pieces (real meshes, e.g. shed wall panels) fly ballistically, bounce once
 * or twice off the ground sampler, come to rest, then fade out and free
 * themselves. Deliberately simple — no piece-vs-piece collision — but reads
 * convincingly for wooden wreckage.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { GroundLike } from '../world/Ground';

interface Piece {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spinAxis: THREE.Vector3;
  spinRate: number;
  age: number;
  resting: boolean;
  halfHeight: number;
}

const MAX_PIECES = 90;
const FADE_START = 14; // s
const LIFETIME = 19; // s

export class Debris {
  private readonly pieces: Piece[] = [];
  private readonly tmpQ = new THREE.Quaternion();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly ground: GroundLike,
  ) {}

  add(mesh: THREE.Mesh, vel: THREE.Vector3): void {
    if (this.pieces.length >= MAX_PIECES) {
      const old = this.pieces.shift()!;
      this.dispose(old);
    }
    // per-piece material clone so each can fade independently
    const mat = (mesh.material as THREE.Material).clone();
    mat.transparent = true;
    mesh.material = mat;
    mesh.castShadow = true;

    mesh.geometry.computeBoundingSphere();
    const r = mesh.geometry.boundingSphere?.radius ?? 0.5;

    this.scene.add(mesh);
    this.pieces.push({
      mesh,
      vel: vel.clone(),
      spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      spinRate: (Math.random() - 0.5) * 7,
      age: 0,
      resting: false,
      halfHeight: Math.min(r * 0.35, 0.3),
    });
  }

  update(dt: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;

      if (!p.resting) {
        p.vel.y -= 9.81 * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        this.tmpQ.setFromAxisAngle(p.spinAxis, p.spinRate * dt);
        p.mesh.quaternion.premultiply(this.tmpQ);

        const gy = this.ground.getHeight(p.mesh.position.x, p.mesh.position.z) + p.halfHeight;
        if (p.mesh.position.y < gy) {
          p.mesh.position.y = gy;
          if (Math.abs(p.vel.y) < 1.6 && p.vel.lengthSq() < 4) {
            p.resting = true;
          } else {
            p.vel.y = Math.abs(p.vel.y) * -0.32;
            p.vel.x *= 0.55;
            p.vel.z *= 0.55;
            p.spinRate *= 0.5;
          }
        }
      }

      if (p.age > FADE_START) {
        const f = 1 - (p.age - FADE_START) / (LIFETIME - FADE_START);
        (p.mesh.material as THREE.Material).opacity = Math.max(0, f);
      }
      if (p.age > LIFETIME) {
        this.dispose(p);
        this.pieces.splice(i, 1);
      }
    }
  }

  private dispose(p: Piece): void {
    this.scene.remove(p.mesh);
    (p.mesh.material as THREE.Material).dispose();
  }
}
