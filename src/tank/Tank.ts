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

import { intersectTankSegment, resolvePenetration, HitFacet, HitResult } from '../sim/hittest';

export type { HitFacet, HitResult } from '../sim/hittest';

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
   * Swept-segment vs hull OBB + turret cylinder (shared sim code).
   * Returns the world hit point and which armor facet was struck.
   */
  intersectSegment(a: THREE.Vector3, b: THREE.Vector3): { point: THREE.Vector3; facet: HitFacet } | null {
    return intersectTankSegment(
      a, b,
      { position: this.position, quaternion: this.model.root.quaternion, turretYaw: this.gun.turretYaw },
      this.spec.hitbox,
    );
  }

  /** Resolve a shell hit locally (singleplayer): penetration roll vs armor. */
  takeHit(meta: ShellMeta, facet: HitFacet, flightDist: number): HitResult {
    const res = resolvePenetration(this.spec, meta, facet, flightDist);
    if (res.penetrated && !this.destroyed) {
      this.hp = Math.max(0, this.hp - res.damage);
      const killed = this.hp <= 0;
      if (killed) this.destroy();
      return { type: 'penetration', facet, destroyed: killed, damage: res.damage };
    }
    return { type: 'ricochet', facet, destroyed: false, damage: 0 };
  }

  /** Mark destroyed (also used when the server says so in multiplayer). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // burnt-out look: darken this tank's material set
    for (const mat of Object.values(this.materials)) {
      const m = mat as THREE.MeshStandardMaterial;
      m.color.multiplyScalar(0.32);
      m.roughness = 1;
    }
  }

  /** Undo destroy() for a multiplayer respawn. */
  revive(): void {
    if (this.destroyed) {
      for (const mat of Object.values(this.materials)) {
        const m = mat as THREE.MeshStandardMaterial;
        m.color.multiplyScalar(1 / 0.32);
        m.roughness = m.roughness === 1 ? 0.8 : m.roughness;
      }
    }
    this.destroyed = false;
    this.hp = this.spec.hp;
  }

  /* ---- adapters used by the AI and the shared turret sim ---- */

  private readonly velVec = new THREE.Vector3();

  /** Hull velocity as a THREE vector (AITargetLike). */
  get velocity(): THREE.Vector3 {
    const v = this.physics.body.velocity;
    return this.velVec.set(v.x, v.y, v.z);
  }

  get hullQuaternion(): THREE.Quaternion {
    return this.model.root.quaternion;
  }

  gunWorldDir(out: THREE.Vector3): THREE.Vector3 {
    return this.model.recoilGroup.getWorldDirection(out);
  }

  get gunReadiness(): number {
    return this.gun.reloadProgress;
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
