/* ---------------------------------------------------------------------------
 * Server-side tank: the real TankPhysics + analytic turret, no visuals.
 * Drives the same TankAI the singleplayer duel uses, so the room's resident
 * AI behaves identically online.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TankSpec } from '../src/tank/config';
import { TankPhysics, DriveInput } from '../src/tank/TankPhysics';
import { GroundLike } from '../src/world/Ground';
import { AITankLike } from '../src/ai/TankAI';
import { TurretState, updateTurretAim, gunWorldDir, muzzleWorldPos } from '../src/sim/turret';

export class HeadlessTank implements AITankLike {
  readonly physics: TankPhysics;
  readonly turret: TurretState = { yaw: 0, pitch: 0 };

  hp: number;
  destroyed = false;
  reload = 0;

  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly hullQuaternion = new THREE.Quaternion();

  private readonly dir = new THREE.Vector3();
  private flipTimer = 0;

  constructor(
    public spec: TankSpec,
    private readonly ground: GroundLike,
  ) {
    this.hp = spec.hp;
    this.physics = new TankPhysics(ground, spec);
    this.sync();
  }

  placeAt(x: number, z: number, yaw: number): void {
    const b = this.physics.body;
    b.position.set(x, this.ground.getHeight(x, z) + this.spec.originHeight + 0.4, z);
    b.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0) as never, yaw);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    this.sync();
  }

  /**
   * Step physics + turret. Returns muzzle pos/dir when a shot goes off.
   */
  update(
    dt: number,
    drive: DriveInput,
    aimDir: THREE.Vector3,
    wantFire: boolean,
  ): { firedFrom: THREE.Vector3; firedDir: THREE.Vector3 } | null {
    if (this.destroyed) {
      drive = { throttle: 0, steer: 0, brake: true };
      wantFire = false;
    }
    this.physics.update(dt, drive);
    this.sync();

    updateTurretAim(this.spec, this.hullQuaternion, aimDir, dt, this.turret);
    this.reload = Math.max(0, this.reload - dt);

    // safety net beyond the AI's own recovery: hard-flip while dead in water
    const up = this.dir.set(0, 1, 0).applyQuaternion(this.hullQuaternion);
    if (up.y < 0.2) {
      this.flipTimer += dt;
      if (this.flipTimer > 6) {
        this.physics.resetUpright();
        this.flipTimer = 0;
      }
    } else {
      this.flipTimer = 0;
    }

    if (wantFire && this.reload <= 0 && !this.destroyed) {
      this.reload = this.spec.gun.reloadTime;
      const from = new THREE.Vector3();
      const d = new THREE.Vector3();
      muzzleWorldPos(this.spec, this.position, this.hullQuaternion, this.turret, from);
      gunWorldDir(this.hullQuaternion, this.turret, d);
      return { firedFrom: from, firedDir: d };
    }
    return null;
  }

  gunWorldDir(out: THREE.Vector3): THREE.Vector3 {
    return gunWorldDir(this.hullQuaternion, this.turret, out);
  }

  get gunReadiness(): number {
    return 1 - this.reload / this.spec.gun.reloadTime;
  }

  private sync(): void {
    const b = this.physics.body;
    this.position.set(b.position.x, b.position.y, b.position.z);
    this.hullQuaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    this.forward.set(0, 0, 1).applyQuaternion(this.hullQuaternion);
  }
}
