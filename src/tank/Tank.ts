/* ---------------------------------------------------------------------------
 * Tank facade: physics + model + tracks + gun for ANY TankSpec, plus the
 * damage model (armor facets, penetration, hit points, destruction).
 *
 * Per frame:
 *   1. step physics  2. sync visuals  3. animate running gear
 *   4. conform/scroll tracks  5. fire control  6. exhaust & dust
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TankSpec } from './config';
import { TankPhysics, DriveInput } from './TankPhysics';
import { TigerModel, TankModelLike } from './TigerModel';
import { T34Model } from './T34Model';
import { Tracks } from './Tracks';
import { Gun, GunTriggers } from './Gun';
import { createTankMaterials, TankMaterials } from './materials';
import { GroundLike } from '../world/Ground';
import { Particles } from '../effects/Particles';
import { Projectiles } from '../effects/Projectiles';
import { AudioManager } from '../audio/AudioManager';
import { clamp } from '../utils/math';

export type HitFacet =
  | 'hullFront' | 'hullSide' | 'hullRear'
  | 'turretFront' | 'turretSide' | 'turretRear'
  | 'top';

export interface HitResult {
  type: 'penetration' | 'ricochet';
  facet: HitFacet;
  destroyed: boolean;
  damage: number;
}

export interface ShellMeta {
  shooter: Tank | null;
  pen0: number;
  penFalloff: number;
  damage: readonly [number, number];
}

export class Tank {
  readonly physics: TankPhysics;
  readonly model: TankModelLike;
  readonly tracks: Tracks;
  readonly gun: Gun;
  readonly materials: TankMaterials;

  hp: number;
  destroyed = false;

  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);

  private distLeft = 0;
  private distRight = 0;
  private exhaustAcc = 0;
  private readonly wheelYLeft: number[] = [];
  private readonly wheelYRight: number[] = [];

  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly localA = new THREE.Vector3();
  private readonly localB = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    ground: GroundLike,
    private readonly particles: Particles,
    projectiles: Projectiles,
    audio: AudioManager,
    readonly spec: TankSpec,
  ) {
    this.hp = spec.hp;
    this.materials = createTankMaterials(spec.camoScheme);
    this.physics = new TankPhysics(ground, spec);
    this.model = spec.id === 'tiger' ? new TigerModel(this.materials) : new T34Model(this.materials);
    this.tracks = new Tracks(spec, this.model.root, this.materials.track);
    this.gun = new Gun(spec, this.model, this.physics, projectiles, particles, audio);
    this.gun.owner = this;
    scene.add(this.model.root);
  }

  /** Place the tank at (x, z), facing `yaw`. */
  placeAt(x: number, z: number, yaw: number, ground: GroundLike): void {
    const b = this.physics.body;
    b.position.set(x, ground.getHeight(x, z) + this.spec.originHeight + 0.4, z);
    b.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0) as never, yaw);
    b.velocity.setZero();
    b.angularVelocity.setZero();
  }

  update(dt: number, drive: DriveInput, aimDir: THREE.Vector3, triggers: GunTriggers): void {
    if (this.destroyed) {
      // dead tanks brake to a halt and stop responding
      drive = { throttle: 0, steer: 0, brake: true };
      triggers = { fireMain: false, fireCoax: false, fireHullMG: false };
    }

    // 1. physics
    this.physics.update(dt, drive);

    // 2. sync visual root with the body
    const b = this.physics.body;
    this.model.root.position.set(b.position.x, b.position.y, b.position.z);
    this.model.root.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    this.position.copy(this.model.root.position);
    this.forward.set(0, 0, 1).applyQuaternion(this.model.root.quaternion);

    // 3. running gear animation
    this.distLeft += this.physics.trackSpeedLeft * dt;
    this.distRight += this.physics.trackSpeedRight * dt;

    const stations = this.physics.stations;
    const nWheels = this.spec.wheelAxlesZ.length;
    this.wheelYLeft.length = 0;
    this.wheelYRight.length = 0;
    for (let i = 0; i < nWheels; i++) {
      const compL = stations[i].visualCompression;
      const compR = stations[nWheels + i].visualCompression;
      // wheel center = hardpoint − (rest − compression)
      this.wheelYLeft.push(this.spec.hardpointY - this.spec.suspensionRest + compL);
      this.wheelYRight.push(this.spec.hardpointY - this.spec.suspensionRest + compR);
    }

    // rolling constraint: contact point stationary ⇒ spin = +distance/r
    const spinL = this.distLeft / this.spec.wheelRadius;
    const spinR = this.distRight / this.spec.wheelRadius;
    for (let i = 0; i < nWheels; i++) {
      const wl = this.model.wheelsLeft[i];
      const wr = this.model.wheelsRight[i];
      wl.position.y = this.wheelYLeft[i];
      wr.position.y = this.wheelYRight[i];
      wl.rotation.x = spinL;
      wr.rotation.x = spinR;
    }
    const sprocketR = this.spec.sprocket.r + this.spec.trackThickness / 2;
    const idlerR = this.spec.idler.r + this.spec.trackThickness / 2;
    this.model.sprockets[0].rotation.x = this.distLeft / sprocketR;
    this.model.sprockets[1].rotation.x = this.distRight / sprocketR;
    this.model.idlers[0].rotation.x = this.distLeft / idlerR;
    this.model.idlers[1].rotation.x = this.distRight / idlerR;

    // 4. tracks conform to the animated wheels and scroll with ground speed
    this.tracks.update(
      dt,
      this.physics.trackSpeedLeft,
      this.physics.trackSpeedRight,
      this.wheelYLeft,
      this.wheelYRight,
    );

    // 5. fire control
    this.gun.update(dt, aimDir, triggers);

    // 6. effects
    if (!this.destroyed) {
      this.emitExhaust(dt);
      this.emitDust();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Damage model                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Swept-segment vs hull OBB + turret cylinder.
   * Returns the world hit point and which armor facet was struck.
   */
  intersectSegment(a: THREE.Vector3, b: THREE.Vector3): { point: THREE.Vector3; facet: HitFacet } | null {
    const hb = this.spec.hitbox;
    this.tmpQ.copy(this.model.root.quaternion).invert();
    this.localA.copy(a).sub(this.position).applyQuaternion(this.tmpQ);
    this.localB.copy(b).sub(this.position).applyQuaternion(this.tmpQ);

    // hull slab test (box: ±halfW, hullBottomY..hullTopY+turretH, ±halfL —
    // the tall box includes the turret; facet is resolved afterwards)
    const min = { x: -hb.halfW, y: hb.hullBottomY - 0.35, z: -hb.halfL };
    const max = { x: hb.halfW, y: hb.hullTopY + hb.turretH, z: hb.halfL };
    const d = this.localB.clone().sub(this.localA);
    let tMin = 0;
    let tMax = 1;
    let entryAxis: 'x' | 'y' | 'z' = 'z';
    for (const axis of ['x', 'y', 'z'] as const) {
      const o = this.localA[axis];
      const dd = d[axis];
      const lo = min[axis];
      const hi = max[axis];
      if (Math.abs(dd) < 1e-9) {
        if (o < lo || o > hi) return null;
        continue;
      }
      let t1 = (lo - o) / dd;
      let t2 = (hi - o) / dd;
      if (t1 > t2) {
        const tt = t1;
        t1 = t2;
        t2 = tt;
      }
      if (t1 > tMin) {
        tMin = t1;
        entryAxis = axis;
      }
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return null;
    }

    const hitLocal = this.localA.clone().addScaledVector(d, tMin);

    // above the hull roof? then it only counts if it strikes the turret
    if (hitLocal.y > hb.hullTopY - 0.02) {
      return this.turretIntersect(this.localA, d, hb);
    }

    // hull facet from the entered face + travel direction
    let facet: HitFacet;
    if (entryAxis === 'y') facet = 'top';
    else if (entryAxis === 'x') facet = 'hullSide';
    else facet = d.z < 0 ? 'hullFront' : 'hullRear';

    const point = hitLocal.applyQuaternion(this.model.root.quaternion).add(this.position);
    return { point, facet };
  }

  /** Segment vs vertical turret cylinder; facet from approach direction. */
  private turretIntersect(
    a: THREE.Vector3,
    d: THREE.Vector3,
    hb: TankSpec['hitbox'],
  ): { point: THREE.Vector3; facet: HitFacet } | null {
    // march the local segment and find where it enters the cylinder
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + d.x * t;
      const y = a.y + d.y * t;
      const z = a.z + d.z * t;
      if (y < hb.hullTopY - 0.02 || y > hb.hullTopY + hb.turretH + 0.15) continue;
      const dx = x;
      const dz = z - hb.turretZ;
      if (dx * dx + dz * dz > hb.turretR * hb.turretR) continue;

      // impact direction relative to turret facing
      const turretYaw = this.gun.turretYaw;
      const dirYaw = Math.atan2(-d.x, -d.z); // where the shell CAME from, hull-local
      let rel = dirYaw - turretYaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const absRel = Math.abs(rel);
      const facet: HitFacet =
        d.y < -0.55 * Math.hypot(d.x, d.z)
          ? 'top'
          : absRel < (65 * Math.PI) / 180
            ? 'turretFront'
            : absRel < (125 * Math.PI) / 180
              ? 'turretSide'
              : 'turretRear';

      const point = new THREE.Vector3(x, y, z)
        .applyQuaternion(this.model.root.quaternion)
        .add(this.position);
      return { point, facet };
    }
    return null;
  }

  /** Resolve a shell hit: penetration roll vs facet armor. */
  takeHit(meta: ShellMeta, facet: HitFacet, flightDist: number): HitResult {
    const pen = Math.max(5, meta.pen0 - meta.penFalloff * flightDist);
    const armor = this.spec.armor[facet];
    const roll = pen * (0.88 + Math.random() * 0.24);

    if (roll > armor && !this.destroyed) {
      const dmg = meta.damage[0] + Math.random() * (meta.damage[1] - meta.damage[0]);
      this.hp = Math.max(0, this.hp - dmg);
      const killed = this.hp <= 0;
      if (killed) this.destroy();
      return { type: 'penetration', facet, destroyed: killed, damage: dmg };
    }
    return { type: 'ricochet', facet, destroyed: false, damage: 0 };
  }

  private destroy(): void {
    this.destroyed = true;
    // burnt-out look: darken this tank's material set
    for (const mat of Object.values(this.materials)) {
      const m = mat as THREE.MeshStandardMaterial;
      m.color.multiplyScalar(0.32);
      m.roughness = 1;
    }
  }

  /* ------------------------------------------------------------------ */

  private emitExhaust(dt: number): void {
    const load = this.physics.engineLoad;
    this.exhaustAcc += dt * (5 + load * 20);
    while (this.exhaustAcc >= 1) {
      this.exhaustAcc -= 1;
      for (const pipe of this.model.exhausts) {
        pipe.getWorldPosition(this.tmp);
        this.particles.exhaustPuff(this.tmp, load);
      }
    }
  }

  private emitDust(): void {
    for (const side of [1, -1] as const) {
      const speed = side === 1 ? this.physics.trackSpeedLeft : this.physics.trackSpeedRight;
      const target = side === 1 ? this.physics.targetSpeedLeft : this.physics.targetSpeedRight;
      const slip = Math.abs(target - speed);
      const intensity = clamp((Math.abs(speed) - 0.5) * 0.12 + slip * 0.35, 0, 1.3);
      if (intensity < 0.06) continue;

      const base = side === 1 ? 0 : this.spec.wheelAxlesZ.length;
      let contact = false;
      for (let i = 0; i < this.spec.wheelAxlesZ.length; i++) {
        if (this.physics.stations[base + i].contact) {
          contact = true;
          break;
        }
      }
      if (!contact) continue;

      const rearZ = speed >= 0 ? -this.spec.hitbox.halfL * 0.8 : this.spec.hitbox.halfL * 0.8;
      this.tmp
        .set(side * this.spec.trackCenterX, this.spec.hullBottomY - 0.35, rearZ)
        .applyQuaternion(this.model.root.quaternion)
        .add(this.model.root.position);
      this.tmpB.copy(this.forward).multiplyScalar(-Math.sign(speed) || -1);
      this.particles.trackDust(this.tmp, this.tmpB, intensity);
    }
  }
}
