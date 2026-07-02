/* ---------------------------------------------------------------------------
 * Fire control: turret traverse, gun elevation, the 8.8 cm KwK 36 itself,
 * plus coaxial and hull MG 34s.
 *
 * The turret chases the commander's aim direction (the camera) at a rate
 * limited by the Tiger's hydraulic traverse — you feel the weight. Firing
 * spawns a ballistic shell, muzzle blast particles, barrel recoil and a
 * hull impulse through the physics body.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TIGER } from './config';
import { TigerModel } from './TigerModel';
import { TankPhysics } from './TankPhysics';
import { Projectiles } from '../effects/Projectiles';
import { Particles } from '../effects/Particles';
import { AudioManager } from '../audio/AudioManager';
import { clamp, damp, rotateTowards } from '../utils/math';

export interface GunTriggers {
  fireMain: boolean;
  fireCoax: boolean;
  fireHullMG: boolean;
}

export class Gun {
  turretYaw = 0; // hull-local
  gunPitch = 0; // positive = elevated

  ammo = TIGER.gun.ammo;
  reload = 0; // seconds until ready
  private recoil = 0;
  private coaxCooldown = 0;
  private hullCooldown = 0;
  private reloadAnnounced = true;

  /** Camera-shake hook, set by Game. */
  onFired: (() => void) | null = null;

  private readonly q = new THREE.Quaternion();
  private readonly aimLocal = new THREE.Vector3();
  private readonly muzzlePos = new THREE.Vector3();
  private readonly muzzleDir = new THREE.Vector3();

  constructor(
    private readonly model: TigerModel,
    private readonly physics: TankPhysics,
    private readonly projectiles: Projectiles,
    private readonly particles: Particles,
    private readonly audio: AudioManager,
  ) {}

  update(dt: number, aimDirWorld: THREE.Vector3, triggers: GunTriggers): void {
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
    this.turretYaw = rotateTowards(this.turretYaw, yawTarget, TIGER.gun.traverseRate * dt);
    this.gunPitch = rotateTowards(
      this.gunPitch,
      clamp(pitchTarget, -TIGER.gun.depressionMax, TIGER.gun.elevationMax),
      TIGER.gun.elevateRate * dt,
    );

    this.model.turretPivot.rotation.y = this.turretYaw;
    this.model.gunPivot.rotation.x = -this.gunPitch;

    // ---- recoil recovery (fast kick handled in fire(), slow run-out here) ----
    this.recoil = damp(this.recoil, 0, 3.2, dt);
    this.model.recoilGroup.position.z = -this.recoil;

    // ---- reload ----
    if (this.reload > 0) {
      this.reload -= dt;
      if (this.reload <= 0 && !this.reloadAnnounced) {
        this.reloadAnnounced = true;
        this.audio.playReloadDone();
      }
    }

    // ---- triggers ----
    if (triggers.fireMain) this.tryFireMain();

    this.coaxCooldown -= dt;
    if (triggers.fireCoax && this.coaxCooldown <= 0) {
      this.coaxCooldown = 1 / 14; // MG 34 ≈ 850 rpm
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

    this.model.muzzle.getWorldPosition(this.muzzlePos);
    this.model.recoilGroup.getWorldDirection(this.muzzleDir);

    // slight dispersion
    this.muzzleDir.x += (Math.random() - 0.5) * 0.004;
    this.muzzleDir.y += (Math.random() - 0.5) * 0.004;
    this.muzzleDir.normalize();

    this.projectiles.fireShell(this.muzzlePos, this.muzzleDir, TIGER.gun.muzzleVelocity);
    this.particles.muzzleBlast(this.muzzlePos, this.muzzleDir);
    this.audio.playCannon();
    this.physics.applyRecoilImpulse(this.muzzleDir, 34000);

    this.recoil = TIGER.gun.recoilDistance;
    this.ammo--;
    this.reload = TIGER.gun.reloadTime;
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

    this.projectiles.fireBullet(this.muzzlePos, this.muzzleDir);
    this.particles.mgFlash(this.muzzlePos, this.muzzleDir);
    this.audio.playMG();
  }

  /** 0 (just fired) → 1 (ready). */
  get reloadProgress(): number {
    return 1 - clamp(this.reload / TIGER.gun.reloadTime, 0, 1);
  }

  /** World position the gun currently points at, projected `range` out. */
  getGunAimPoint(range: number, out: THREE.Vector3): THREE.Vector3 {
    this.model.muzzle.getWorldPosition(out);
    this.model.recoilGroup.getWorldDirection(this.muzzleDir);
    return out.addScaledVector(this.muzzleDir, range);
  }
}
