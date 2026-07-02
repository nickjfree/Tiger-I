/* ---------------------------------------------------------------------------
 * Ballistic projectiles: 8.8 cm shells and MG bullets.
 *
 * Simple but honest exterior ballistics — gravity + slight drag, integrated
 * per frame, with segment tests against the analytic terrain and the practice
 * targets. Shells render as a glowing tracer mesh + smoke trail; impacts
 * trigger the particle explosion, a light flash and a distance-attenuated
 * sound.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Terrain } from '../world/Terrain';
import { Targets } from '../world/Targets';
import { Particles } from './Particles';

interface Projectile {
  kind: 'shell' | 'bullet';
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  mesh: THREE.Mesh | null;
  trailTimer: number;
}

const SHELL_DRAG = 0.012;
const MAX_AGE = 9;

export class Projectiles {
  private readonly live: Projectile[] = [];
  private readonly shellGeo: THREE.BufferGeometry;
  private readonly shellMat: THREE.MeshBasicMaterial;
  private readonly flashLight: THREE.PointLight;
  private flashTtl = 0;

  /** Hook for camera shake / audio: (position, isShellExplosion). */
  onImpact: ((pos: THREE.Vector3, big: boolean) => void) | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: Terrain,
    private readonly targets: Targets,
    private readonly particles: Particles,
  ) {
    // elongated tracer along +Z
    this.shellGeo = new THREE.CylinderGeometry(0.035, 0.05, 1.1, 8);
    this.shellGeo.rotateX(Math.PI / 2);
    this.shellMat = new THREE.MeshBasicMaterial({ color: 0xffc26a });

    this.flashLight = new THREE.PointLight(0xffa040, 0, 60, 1.8);
    scene.add(this.flashLight);
  }

  fireShell(pos: THREE.Vector3, dir: THREE.Vector3, speed: number): void {
    const mesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.live.push({
      kind: 'shell',
      pos: pos.clone(),
      prev: pos.clone(),
      vel: dir.clone().normalize().multiplyScalar(speed),
      age: 0,
      mesh,
      trailTimer: 0,
    });
  }

  fireBullet(pos: THREE.Vector3, dir: THREE.Vector3, speed = 320): void {
    this.live.push({
      kind: 'bullet',
      pos: pos.clone(),
      prev: pos.clone(),
      vel: dir.clone().normalize().multiplyScalar(speed),
      age: 0,
      mesh: null,
      trailTimer: 0,
    });
  }

  update(dt: number): void {
    // fading muzzle/impact light
    if (this.flashTtl > 0) {
      this.flashTtl -= dt;
      this.flashLight.intensity = Math.max(0, this.flashTtl * 260);
    }

    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      p.prev.copy(p.pos);

      // integrate: gravity + mild aerodynamic drag
      p.vel.y -= 9.81 * dt;
      if (p.kind === 'shell') p.vel.multiplyScalar(1 - SHELL_DRAG * dt);
      p.pos.addScaledVector(p.vel, dt);

      // target hit test on the swept segment
      const targetHit = this.targets.testSegment(p.prev, p.pos);
      if (targetHit) {
        this.impact(p, targetHit, this.upNormal());
        this.remove(i);
        continue;
      }

      // terrain hit test: sample along the segment
      const hit = this.terrainHit(p.prev, p.pos);
      if (hit) {
        this.impact(p, hit, this.terrain.getNormal(hit.x, hit.z));
        this.remove(i);
        continue;
      }

      if (p.age > MAX_AGE) {
        this.remove(i);
        continue;
      }

      // visuals
      if (p.mesh) {
        p.mesh.position.copy(p.pos);
        p.mesh.lookAt(this.tmp.copy(p.pos).add(p.vel));
        p.trailTimer -= dt;
        if (p.trailTimer <= 0) {
          p.trailTimer = 0.016;
          this.particles.shellTrail(p.pos);
        }
      }
    }
  }

  private readonly tmp = new THREE.Vector3();
  private readonly tmpN = new THREE.Vector3();

  private upNormal(): THREE.Vector3 {
    return this.tmpN.set(0, 1, 0);
  }

  private terrainHit(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null {
    const dist = a.distanceTo(b);
    const steps = Math.max(1, Math.ceil(dist / 1.5));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const z = a.z + (b.z - a.z) * t;
      if (y <= this.terrain.getHeight(x, z)) {
        // refine to the surface
        this.tmp.set(x, this.terrain.getHeight(x, z) + 0.02, z);
        return this.tmp;
      }
    }
    return null;
  }

  private impact(p: Projectile, at: THREE.Vector3, normal: THREE.Vector3): void {
    if (p.kind === 'shell') {
      this.particles.explosion(at, normal);
      this.flashLight.position.copy(at).addScaledVector(normal, 1.2);
      this.flashTtl = 0.12;
      this.onImpact?.(at, true);
    } else {
      this.particles.bulletImpact(at);
      this.onImpact?.(at, false);
    }
  }

  private remove(i: number): void {
    const p = this.live[i];
    if (p.mesh) this.scene.remove(p.mesh);
    this.live.splice(i, 1);
  }
}
