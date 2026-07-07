/* ---------------------------------------------------------------------------
 * Sympathetic detonation ("ammo cook-off") after a tank is destroyed.
 *
 * For ~8 s after the kill, stowed ammunition detonates in randomized
 * secondary blasts: flash + sparks + smoke out of the hull, fire jets from
 * the turret ring, distance-attenuated cracks and booms. On a catastrophic
 * kill the turret is blown clean off — ballistic arc, tumbling, landing
 * where it falls — and is quietly re-seated when the tank respawns.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TankSpec } from '../tank/config';
import { GroundLike } from '../world/Ground';
import { Particles } from './Particles';
import { AudioManager } from '../audio/AudioManager';
import { clamp } from '../utils/math';

interface TossedTurret {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spinAxis: THREE.Vector3;
  spinRate: number;
  landed: boolean;
  restY: number;
  // original attachment, for respawn restore
  home: THREE.Object3D;
  homePos: THREE.Vector3;
}

interface Sequence {
  key: string;
  root: THREE.Object3D; // wreck model root (position updates keep working)
  spec: TankSpec;
  timeLeft: number;
  nextPop: number;
  turret: TossedTurret | null;
}

const DURATION = 8.5;

export class CookOffs {
  private readonly seqs: Sequence[] = [];

  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly ground: GroundLike,
    private readonly particles: Particles,
    private readonly audio: AudioManager,
  ) {}

  /**
   * Begin a cook-off on a destroyed tank.
   * @param key         unique id (net id or 'player'/'enemy') for restore
   * @param tossTurret  blow the turret off (keep deterministic across clients)
   */
  start(
    key: string,
    root: THREE.Object3D,
    turretPivot: THREE.Object3D,
    spec: TankSpec,
    tossTurret: boolean,
  ): void {
    this.stop(key); // safety: never two sequences per tank

    const seq: Sequence = {
      key,
      root,
      spec,
      timeLeft: DURATION,
      nextPop: 0.35 + Math.random() * 0.5,
      turret: null,
    };

    if (tossTurret) {
      // detach the turret with its world transform intact
      const homePos = turretPivot.position.clone();
      turretPivot.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      const ws = new THREE.Vector3();
      turretPivot.matrixWorld.decompose(wp, wq, ws);
      root.remove(turretPivot);
      turretPivot.position.copy(wp);
      turretPivot.quaternion.copy(wq);
      this.scene.add(turretPivot);

      seq.turret = {
        obj: turretPivot,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 4,
          8.5 + Math.random() * 3.5,
          (Math.random() - 0.5) * 4,
        ),
        spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).normalize(),
        spinRate: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3),
        landed: false,
        restY: spec.hitbox.turretH * 0.45,
        home: root,
        homePos,
      };

      // launch blast: fire column out of the open turret ring
      this.tmp.copy(wp);
      this.ringFireJet(this.tmp, 2.2);
      this.audio.playCookoff(this.tmp, true);
    }

    this.seqs.push(seq);
  }

  /** Re-seat a tossed turret and end the sequence (respawn). */
  stop(key: string): void {
    for (let i = this.seqs.length - 1; i >= 0; i--) {
      const s = this.seqs[i];
      if (s.key !== key) continue;
      if (s.turret) {
        const t = s.turret;
        this.scene.remove(t.obj);
        t.home.add(t.obj);
        t.obj.position.copy(t.homePos);
        t.obj.rotation.set(0, 0, 0);
      }
      this.seqs.splice(i, 1);
    }
  }

  update(dt: number): void {
    for (let i = this.seqs.length - 1; i >= 0; i--) {
      const s = this.seqs[i];
      s.timeLeft -= dt;

      // ---- secondary detonations ----
      s.nextPop -= dt;
      if (s.nextPop <= 0 && s.timeLeft > 0) {
        // pops thin out as the racks burn down
        const progress = 1 - s.timeLeft / DURATION;
        s.nextPop = 0.35 + Math.random() * (0.5 + progress * 1.6);
        const big = Math.random() < 0.25;
        this.pop(s, big);
      }

      // ---- tossed turret ballistics ----
      const t = s.turret;
      if (t && !t.landed) {
        t.vel.y -= 9.81 * dt;
        t.obj.position.addScaledVector(t.vel, dt);
        this.tmpQ.setFromAxisAngle(t.spinAxis, t.spinRate * dt);
        t.obj.quaternion.premultiply(this.tmpQ);

        const gy = this.ground.getHeight(t.obj.position.x, t.obj.position.z) + t.restY;
        if (t.obj.position.y <= gy && t.vel.y < 0) {
          t.obj.position.y = gy;
          if (Math.abs(t.vel.y) > 3.5) {
            // one bounce with a dirt kick
            t.vel.y = Math.abs(t.vel.y) * 0.25;
            t.vel.x *= 0.5;
            t.vel.z *= 0.5;
            t.spinRate *= 0.45;
            this.dirtKick(t.obj.position);
          } else {
            t.landed = true;
            this.dirtKick(t.obj.position);
            this.audio.playCrash(
              this.tmp.copy(t.obj.position).distanceTo(this.audio.listener),
            );
          }
        }
      }

      if (s.timeLeft <= 0 && (!t || t.landed)) {
        this.seqs.splice(i, 1); // turret stays where it fell (until respawn)
      }
    }
  }

  /* ------------------------------------------------------------------ */

  /** One ammo detonation somewhere inside the hull. */
  private pop(s: Sequence, big: boolean): void {
    const hb = s.spec.hitbox;
    this.tmp
      .set(
        (Math.random() - 0.5) * hb.halfW * 1.2,
        hb.hullTopY + 0.2,
        (Math.random() - 0.5) * hb.halfL * 1.1,
      )
      .applyQuaternion(s.root.quaternion)
      .add(s.root.position);

    // flash
    this.particles.emit({
      pos: this.tmp,
      vel: this.tmpB.set(0, big ? 6 : 3.5, 0),
      velSpread: big ? 4 : 2,
      count: big ? 12 : 6,
      life: [0.05, 0.14],
      size: [big ? 1.4 : 0.8, big ? 2.6 : 1.4],
      sizeEnd: 2.2,
      color: 0xffe9b0,
      colorEnd: 0xff7a20,
      alpha: 1,
      additive: true,
    });
    // sparks (tracer rounds cooking off)
    this.particles.emit({
      pos: this.tmp,
      vel: this.tmpB.set(0, big ? 11 : 7, 0),
      velSpread: big ? 9 : 5.5,
      count: big ? 22 : 10,
      life: [0.4, 1.1],
      size: [0.08, 0.2],
      sizeEnd: 0.5,
      color: 0xffd070,
      colorEnd: 0xff5010,
      alpha: 1,
      gravity: 11,
      drag: 0.4,
      additive: true,
    });
    // smoke slug
    this.particles.emit({
      pos: this.tmp,
      posSpread: 0.3,
      vel: this.tmpB.set(0, 2.4, 0),
      velSpread: 1.1,
      count: big ? 10 : 5,
      life: [1.0, 2.2],
      size: [0.8, 1.4],
      sizeEnd: 3.6,
      color: 0x24211d,
      colorEnd: 0x4a463f,
      alpha: 0.55,
      drag: 0.8,
      gravity: -0.7,
    });
    if (big) this.ringFireJet(this.tmp, 1.2);

    this.audio.playCookoff(this.tmp, big);
  }

  /** Vertical flame column (open hatches / turret ring). */
  private ringFireJet(at: THREE.Vector3, strength: number): void {
    this.particles.emit({
      pos: at,
      posSpread: 0.25,
      vel: this.tmpB.set(0, 10 * strength, 0),
      velSpread: 2.2,
      count: Math.round(16 * strength),
      life: [0.3, 0.8],
      size: [0.6, 1.1],
      sizeEnd: 1.6,
      color: 0xffc860,
      colorEnd: 0xff3d00,
      alpha: 0.95,
      drag: 1.2,
      additive: true,
    });
    this.particles.emit({
      pos: at,
      vel: this.tmpB.set(0, 5.5 * strength, 0),
      velSpread: 1.4,
      count: Math.round(8 * strength),
      life: [1.2, 2.6],
      size: [0.9, 1.5],
      sizeEnd: 4,
      color: 0x1f1c18,
      colorEnd: 0x45413a,
      alpha: 0.5,
      drag: 0.9,
      gravity: -0.8,
    });
  }

  private dirtKick(at: THREE.Vector3): void {
    this.particles.emit({
      pos: at,
      posSpread: 0.4,
      vel: this.tmpB.set(0, 3, 0),
      velSpread: 2.4,
      count: 12,
      life: [0.5, 1.2],
      size: [0.4, 0.9],
      sizeEnd: 2.8,
      color: 0x9a8a68,
      colorEnd: 0x6f6450,
      alpha: clamp(0.5, 0, 1),
      drag: 1.2,
      gravity: 4,
    });
  }
}
