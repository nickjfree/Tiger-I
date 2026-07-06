/* ---------------------------------------------------------------------------
 * Fire control: turret traverse, gun elevation, main gun + MGs.
 * Spec-driven — traverse rates, ballistics, penetration and sound profile
 * all come from the owning tank's TankSpec.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TankSpec } from './config';
import { TankModelLike } from './TigerModel';
import { TankPhysics } from './TankPhysics';
import { Projectiles } from '../effects/Projectiles';
import { Particles } from '../effects/Particles';
import { AudioManager } from '../audio/AudioManager';
import { clamp, damp, rotateTowards } from '../utils/math';
import type { Tank } from './Tank';

export interface GunTriggers {
  fireMain: boolean;
  fireCoax: boolean;
  fireHullMG: boolean;
}

export class Gun {
  turretYaw = 0; // hull-local
  gunPitch = 0; // positive = elevated

  ammo: number;
  reload = 0; // seconds until ready
  private recoil = 0;
  private coaxCooldown = 0;
  private hullCooldown = 0;
  private reloadAnnounced = true;

  /** Set by Tank so projectiles know who fired (self-hit exclusion, HUD). */
  owner: Tank | null = null;

  /** Camera-shake hook, set by Game (player tank only). */
  onFired: (() => void) | null = null;

  /** Suppress reload ping for the AI tank. */
  silentReload = false;

  private readonly q = new THREE.Quaternion();
  private readonly aimLocal = new THREE.Vector3();
  private readonly muzzlePos = new THREE.Vector3();
  private readonly muzzleDir = new THREE.Vector3();

  constructor(
    private readonly spec: TankSpec,
    private readonly model: TankModelLike,
    private readonly physics: TankPhysics,
    private readonly projectiles: Projectiles,
    private readonly particles: Particles,
    private readonly audio: AudioManager,
  ) {
    this.ammo = spec.gun.ammo;
  }

  update(dt: number, aimDirWorld: THREE.Vector3, triggers: GunTriggers): void {
    const g = this.spec.gun;

    // ---- resolve aim into hull space ----
    this.q.set(
      this.physics.body.quaternion.x,
      this.physics.body.quaternion.y,
      this.physics.body.quaternion.z,
      this.physics.body.quaternion.w,
    );
    this.aimLocal.copy(aimDirWorld).applyQuaternion(this.q.invert());

    const yawTarget = Math.atan2(this.aimLocal.x, this.aimLocal.z);
    const pitchTarget = Math.atan2(
      this.aimLocal.y,
      Math.hypot(this.aimLocal.x, this.aimLocal.z),
    );

    // ---- rate-limited traverse & elevation ----
    this.turretYaw = rotateTowards(this.turretYaw, yawTarget, g.traverseRate * dt);
    this.gunPitch = rotateTowards(
      this.gunPitch,
      clamp(pitchTarget, -g.depressionMax, g.elevationMax),
      g.elevateRate * dt,
    );

    this.model.turretPivot.rotation.y = this.turretYaw;
    this.model.gunPivot.rotation.x = -this.gunPitch;

    // ---- recoil recovery ----
    this.recoil = damp(this.recoil, 0, 3.2, dt);
    this.model.recoilGroup.position.z = -this.recoil;

    // ---- reload ----
    if (this.reload > 0) {
      this.reload -= dt;
      if (this.reload <= 0 && !this.reloadAnnounced) {
        this.reloadAnnounced = true;
        if (!this.silentReload) this.audio.playReloadDone();
      }
    }

    // ---- triggers ----
    if (triggers.fireMain) this.tryFireMain();

    this.coaxCooldown -= dt;
    if (triggers.fireCoax && this.coaxCooldown <= 0) {
      this.coaxCooldown = 1 / 14;
      this.fireMG(this.model.coaxMuzzle, null);
    }

    this.hullCooldown -= dt;
    if (triggers.fireHullMG && this.hullCooldown <= 0) {
      this.hullCooldown = 1 / 14;
      // hull MG is a fixed ball mount: fires along the hull's forward axis
      this.muzzleDir.set(0, -0.015, 1).applyQuaternion(this.q.invert()).normalize();
      this.fireMG(this.model.hullMGMuzzle, this.muzzleDir);
    }
  }

  private tryFireMain(): void {
    if (this.reload > 0 || this.ammo <= 0) return;
    const g = this.spec.gun;

    this.model.muzzle.getWorldPosition(this.muzzlePos);
    this.model.recoilGroup.getWorldDirection(this.muzzleDir);

    this.muzzleDir.x += (Math.random() - 0.5) * 0.004;
    this.muzzleDir.y += (Math.random() - 0.5) * 0.004;
    this.muzzleDir.normalize();

    this.projectiles.fireShell(this.muzzlePos, this.muzzleDir, g.muzzleVelocity, {
      shooter: this.owner,
      pen0: g.penetration0,
      penFalloff: g.penetrationFalloff,
      damage: g.damage,
    });
    this.particles.muzzleBlast(this.muzzlePos, this.muzzleDir);
    this.audio.playCannon(g.sound, this.muzzlePos);
    this.physics.applyRecoilImpulse(this.muzzleDir, g.recoilImpulse);

    this.recoil = g.recoilDistance;
    this.ammo--;
    this.reload = g.reloadTime;
    this.reloadAnnounced = false;
    this.onFired?.();
  }

  private fireMG(muzzle: THREE.Object3D, fixedDir: THREE.Vector3 | null): void {
    muzzle.getWorldPosition(this.muzzlePos);
    if (fixedDir) {
      this.muzzleDir.copy(fixedDir);
    } else {
      this.model.recoilGroup.getWorldDirection(this.muzzleDir);
    }
    this.muzzleDir.x += (Math.random() - 0.5) * 0.012;
    this.muzzleDir.y += (Math.random() - 0.5) * 0.012;
    this.muzzleDir.normalize();

    this.projectiles.fireBullet(this.muzzlePos, this.muzzleDir, this.owner);
    this.particles.mgFlash(this.muzzlePos, this.muzzleDir);
    this.audio.playMG(this.muzzlePos);
  }

  /** 0 (just fired) → 1 (ready). */
  get reloadProgress(): number {
    return 1 - clamp(this.reload / this.spec.gun.reloadTime, 0, 1);
  }

  /** World position the gun currently points at, projected `range` out. */
  getGunAimPoint(range: number, out: THREE.Vector3): THREE.Vector3 {
    this.model.muzzle.getWorldPosition(out);
    this.model.recoilGroup.getWorldDirection(this.muzzleDir);
    return out.addScaledVector(this.muzzleDir, range);
  }
}
