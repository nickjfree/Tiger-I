/* ---------------------------------------------------------------------------
 * Ballistic projectiles: main-gun shells and MG bullets.
 *
 * Gravity + drag integration per frame, with swept-segment tests against
 * (in priority order): enemy tanks → practice targets → props → terrain.
 * Tank hits resolve through the victim's armor model; the shooter is told
 * the outcome via onTankHit so the HUD can show hit markers.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { GroundLike } from '../world/Ground';
import { Targets } from '../world/Targets';
import { Props } from '../world/Props';
import { Particles } from './Particles';
import type { Tank, ShellMeta, HitResult } from '../tank/Tank';

interface Projectile {
  kind: 'shell' | 'bullet';
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  dist: number; // flight distance for penetration falloff
  mesh: THREE.Mesh | null;
  trailTimer: number;
  meta: ShellMeta | null;
  shooter: Tank | null;
}

const SHELL_DRAG = 0.012;
const MAX_AGE = 9;

export class Projectiles {
  private readonly live: Projectile[] = [];
  private readonly shellGeo: THREE.BufferGeometry;
  private readonly shellMat: THREE.MeshBasicMaterial;
  private readonly flashLight: THREE.PointLight;
  private flashTtl = 0;

  /** Tanks that can be hit (set by Game when a match starts). */
  readonly tanks: Tank[] = [];

  /** Hook for camera shake / audio: (position, isShellExplosion). */
  onImpact: ((pos: THREE.Vector3, big: boolean) => void) | null = null;

  /** Hook fired when a projectile strikes a prop (tree/fence/shed). */
  onPropHit:
    | ((kind: 'tree' | 'fence' | 'shed', index: number, point: THREE.Vector3, dir: THREE.Vector3, shell: boolean) => void)
    | null = null;

  /** Hook fired when a shell strikes a tank. */
  onTankHit:
    | ((shooter: Tank | null, victim: Tank, result: HitResult, point: THREE.Vector3) => void)
    | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: GroundLike,
    private readonly targets: Targets,
    private readonly props: Props,
    private readonly particles: Particles,
  ) {
    this.shellGeo = new THREE.CylinderGeometry(0.035, 0.05, 1.1, 8);
    this.shellGeo.rotateX(Math.PI / 2);
    this.shellMat = new THREE.MeshBasicMaterial({ color: 0xffc26a });

    this.flashLight = new THREE.PointLight(0xffa040, 0, 60, 1.8);
    scene.add(this.flashLight);
  }

  fireShell(pos: THREE.Vector3, dir: THREE.Vector3, speed: number, meta: ShellMeta): void {
    const mesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.live.push({
      kind: 'shell',
      pos: pos.clone(),
      prev: pos.clone(),
      vel: dir.clone().normalize().multiplyScalar(speed),
      age: 0,
      dist: 0,
      mesh,
      trailTimer: 0,
      meta,
      shooter: meta.shooter,
    });
  }

  fireBullet(pos: THREE.Vector3, dir: THREE.Vector3, shooter: Tank | null, speed = 320): void {
    this.live.push({
      kind: 'bullet',
      pos: pos.clone(),
      prev: pos.clone(),
      vel: dir.clone().normalize().multiplyScalar(speed),
      age: 0,
      dist: 0,
      mesh: null,
      trailTimer: 0,
      meta: null,
      shooter,
    });
  }

  update(dt: number): void {
    if (this.flashTtl > 0) {
      this.flashTtl -= dt;
      this.flashLight.intensity = Math.max(0, this.flashTtl * 260);
    }

    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      p.prev.copy(p.pos);

      p.vel.y -= 9.81 * dt;
      if (p.kind === 'shell') p.vel.multiplyScalar(1 - SHELL_DRAG * dt);
      p.pos.addScaledVector(p.vel, dt);
      p.dist += p.prev.distanceTo(p.pos);

      // ---- tanks (highest priority) ----
      let consumed = false;
      for (const tank of this.tanks) {
        if (tank === p.shooter) continue;
        const hit = tank.intersectSegment(p.prev, p.pos);
        if (!hit) continue;

        if (p.kind === 'shell' && p.meta) {
          const result = tank.takeHit(p.meta, hit.facet, p.dist);
          if (result.type === 'penetration') {
            this.particles.explosion(hit.point, this.upNormal());
            this.flashLight.position.copy(hit.point);
            this.flashTtl = 0.1;
          } else {
            this.ricochetSparks(hit.point);
          }
          this.onTankHit?.(p.shooter, tank, result, hit.point);
        } else {
          this.ricochetSparks(hit.point);
        }
        this.remove(i);
        consumed = true;
        break;
      }
      if (consumed) continue;

      // ---- practice targets ----
      const targetHit = this.targets.testSegment(p.prev, p.pos);
      if (targetHit) {
        this.impact(p, targetHit, this.upNormal());
        this.remove(i);
        continue;
      }

      // ---- props (trees / fences / sheds) ----
      const propHit = this.props.hitSegment(p.prev, p.pos);
      if (propHit) {
        this.dir.copy(p.vel).setY(0).normalize();
        this.onPropHit?.(propHit.kind, propHit.index, propHit.point, this.dir, p.kind === 'shell');
        if (p.kind === 'shell' && propHit.kind !== 'shed') {
          p.vel.multiplyScalar(0.92); // shell snaps a tree/fence and flies on
        } else {
          if (p.kind === 'shell') this.impact(p, propHit.point, this.upNormal());
          else this.particles.bulletImpact(propHit.point);
          this.remove(i);
          continue;
        }
      }

      // ---- terrain ----
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
  private readonly dir = new THREE.Vector3();

  private upNormal(): THREE.Vector3 {
    return this.tmpN.set(0, 1, 0);
  }

  /** Bright spark shower for a non-penetrating hit. */
  private ricochetSparks(at: THREE.Vector3): void {
    this.particles.emit({
      pos: at,
      vel: new THREE.Vector3(0, 4, 0),
      velSpread: 7,
      count: 16,
      life: [0.15, 0.5],
      size: [0.1, 0.25],
      sizeEnd: 0.5,
      color: 0xffe9a0,
      colorEnd: 0xff7020,
      alpha: 1,
      gravity: 12,
      drag: 0.5,
      additive: true,
    });
    this.particles.emit({
      pos: at,
      vel: new THREE.Vector3(0, 1.5, 0),
      velSpread: 1,
      count: 4,
      life: [0.4, 0.9],
      size: [0.3, 0.5],
      sizeEnd: 2.5,
      color: 0x9a938a,
      colorEnd: 0x5c5852,
      alpha: 0.4,
      drag: 1.5,
    });
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
