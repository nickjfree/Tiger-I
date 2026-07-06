/* ---------------------------------------------------------------------------
 * AI tank commander.
 *
 * A small state machine driving the same DriveInput/aim interface the player
 * uses, so the AI obeys identical physics (acceleration, traverse rates,
 * reload, gun depression limits — everything).
 *
 *   hunt    → drive toward the enemy (flanking approach if doctrine says so)
 *   combat  → hold preferred range; halt-and-snipe (Tiger) or keep moving
 *             and fire on the move (T-34)
 *   unstick → reverse out when progress stalls
 *
 * Gunnery: full ballistic solution with target lead and gravity drop,
 * iterated twice, plus a per-shot dispersion so the AI is dangerous but
 * beatable. Fires only with a line of sight and a settled aim.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Tank } from '../tank/Tank';
import { DriveInput } from '../tank/TankPhysics';
import { GunTriggers } from '../tank/Gun';
import { GroundLike } from '../world/Ground';
import { angleDelta, clamp } from '../utils/math';

export interface AICommand {
  drive: DriveInput;
  aimDir: THREE.Vector3;
  triggers: GunTriggers;
}

export class TankAI {
  private state: 'hunt' | 'combat' | 'unstick' = 'hunt';
  private stuckTimer = 0;
  private unstickTimer = 0;
  private settleTimer = 0;
  private orbitSign = Math.random() < 0.5 ? 1 : -1;
  private flankOffset = (Math.random() < 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.4);

  private readonly aimDir = new THREE.Vector3(0, 0, 1);
  private readonly cmd: AICommand;

  private readonly toTarget = new THREE.Vector3();
  private readonly aimPos = new THREE.Vector3();
  private readonly gunPos = new THREE.Vector3();
  private readonly gunDir = new THREE.Vector3();
  private readonly targetVel = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();

  constructor(
    private readonly self: Tank,
    private readonly target: Tank,
    private readonly ground: GroundLike,
  ) {
    this.cmd = {
      drive: { throttle: 0, steer: 0, brake: false },
      aimDir: this.aimDir,
      triggers: { fireMain: false, fireCoax: false, fireHullMG: false },
    };
  }

  update(dt: number): AICommand {
    const cmd = this.cmd;
    cmd.triggers.fireMain = false;

    if (this.self.destroyed || this.target.destroyed) {
      cmd.drive.throttle = 0;
      cmd.drive.steer = 0;
      cmd.drive.brake = true;
      return cmd;
    }

    const ai = this.self.spec.ai;
    this.toTarget.copy(this.target.position).sub(this.self.position);
    const dist = Math.hypot(this.toTarget.x, this.toTarget.z);
    const los = this.hasLineOfSight();

    /* ---------------- movement ---------------- */

    // stuck detection
    const speed = Math.hypot(this.self.physics.body.velocity.x, this.self.physics.body.velocity.z);
    if (this.state !== 'unstick' && Math.abs(cmd.drive.throttle) > 0.4 && speed < 0.35) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 2.5) {
        this.state = 'unstick';
        this.unstickTimer = 2.4;
      }
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt);
    }

    if (this.state === 'unstick') {
      this.unstickTimer -= dt;
      cmd.drive.throttle = -0.9;
      cmd.drive.steer = this.orbitSign * 0.7;
      cmd.drive.brake = false;
      if (this.unstickTimer <= 0) {
        this.state = 'hunt';
        this.orbitSign *= -1;
      }
    } else {
      // pick a movement goal
      if (dist > ai.engageRange || !los) {
        this.state = 'hunt';
        // approach on a flanking bearing while far out
        const f = dist > ai.engageRange * 0.7 ? this.flankOffset : this.flankOffset * 0.3;
        this.goal
          .set(this.toTarget.x, 0, this.toTarget.z)
          .normalize()
          .applyAxisAngle(UP, f)
          .multiplyScalar(dist)
          .add(this.self.position);
        this.driveToward(this.goal, 1.0, cmd.drive);
      } else {
        this.state = 'combat';
        if (ai.keepMoving) {
          // circle the target at preferred range, firing on the move
          const radial = this.goal.set(this.toTarget.x, 0, this.toTarget.z).normalize();
          const tangent = new THREE.Vector3(-radial.z * this.orbitSign, 0, radial.x * this.orbitSign);
          const rangeErr = dist - ai.preferredRange;
          // blend: too far → close in; too near → back off; else orbit
          const blend = clamp(rangeErr / 80, -1, 1);
          tangent.addScaledVector(radial, blend).normalize();
          this.goal.copy(this.self.position).addScaledVector(tangent, 30);
          this.driveToward(this.goal, 0.75, cmd.drive);
          if (Math.random() < dt / 7) this.orbitSign *= -1; // vary the circle
        } else {
          // halt and snipe at preferred range
          if (dist > ai.preferredRange + 40) {
            this.driveToward(this.target.position, 0.8, cmd.drive);
          } else {
            cmd.drive.throttle = 0;
            cmd.drive.steer = 0;
            cmd.drive.brake = speed > 0.4;
          }
        }
      }
    }

    /* ---------------- gunnery ---------------- */

    // ballistic solution with lead + drop (2 iterations)
    const mv = this.self.spec.gun.muzzleVelocity;
    this.gunPos.copy(this.self.position).setY(this.self.position.y + 1.6);
    const b = this.target.physics.body;
    this.targetVel.set(b.velocity.x, b.velocity.y, b.velocity.z);
    this.aimPos.copy(this.target.position).setY(this.target.position.y + 0.4);
    for (let k = 0; k < 2; k++) {
      const d = this.aimPos.distanceTo(this.gunPos);
      const t = d / mv;
      this.aimPos
        .copy(this.target.position)
        .setY(this.target.position.y + 0.4)
        .addScaledVector(this.targetVel, t);
      this.aimPos.y += 0.5 * 9.81 * t * t; // hold-over for gravity drop
    }
    this.aimDir.copy(this.aimPos).sub(this.gunPos).normalize();

    // fire when the barrel has settled on the solution
    this.self.model.recoilGroup.getWorldDirection(this.gunDir);
    const aimErr = this.gunDir.angleTo(this.aimDir);
    const steady = ai.keepMoving || speed < 1.5;
    if (aimErr < 0.015 && los && steady && dist < ai.engageRange) {
      this.settleTimer += dt;
      if (this.settleTimer > ai.reactionTime && this.self.gun.reloadProgress >= 1) {
        // per-shot dispersion, worse when moving
        const err = ai.aimError * (ai.keepMoving && speed > 2 ? 2.2 : 1);
        this.aimDir.x += gauss() * err;
        this.aimDir.y += gauss() * err;
        this.aimDir.normalize();
        cmd.triggers.fireMain = true;
        this.settleTimer = ai.reactionTime * 0.55; // follow-up shots come faster
      }
    } else {
      this.settleTimer = Math.max(0, this.settleTimer - dt * 2);
    }

    return cmd;
  }

  /** Steer/throttle toward a world point. */
  private driveToward(point: THREE.Vector3, maxThrottle: number, out: DriveInput): void {
    const desiredYaw = Math.atan2(point.x - this.self.position.x, point.z - this.self.position.z);
    const curYaw = Math.atan2(this.self.forward.x, this.self.forward.z);
    const err = angleDelta(curYaw, desiredYaw);
    // steer > 0 turns right (decreasing yaw), so oppose the error sign
    out.steer = clamp(-err * 1.6, -1, 1);
    out.throttle = Math.abs(err) < 0.5 ? maxThrottle : Math.abs(err) < 1.2 ? maxThrottle * 0.45 : 0.12;
    out.brake = false;
  }

  /** Terrain line-of-sight from own gun height to target center. */
  private hasLineOfSight(): boolean {
    const ax = this.self.position.x;
    const ay = this.self.position.y + 1.9;
    const az = this.self.position.z;
    const bx = this.target.position.x;
    const by = this.target.position.y + 1.2;
    const bz = this.target.position.z;
    for (let i = 1; i < 10; i++) {
      const t = i / 10;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      if (this.ground.getHeight(x, z) > y - 0.4) return false;
    }
    return true;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** Cheap standard-normal-ish random. */
function gauss(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 0.82;
}
