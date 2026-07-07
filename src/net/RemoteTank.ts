/* ---------------------------------------------------------------------------
 * A remote player's (or the server AI's) tank: the full visual model driven
 * by interpolated network snapshots instead of local physics.
 *
 * Renders ~INTERP_DELAY_MS in the past and lerps/slerps between the two
 * bracketing snapshots, so motion is smooth at any (reasonable) packet rate.
 * Tracks scroll and wheels spin from the snapshot's track speeds; dust and
 * exhaust are emitted locally from the same values, so a remote tank looks
 * exactly like a local one.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TankSpec, SPECS } from '../tank/config';
import { TigerModel, TankModelLike } from '../tank/TigerModel';
import { T34Model } from '../tank/T34Model';
import { Tracks } from '../tank/Tracks';
import { createTankMaterials, TankMaterials } from '../tank/materials';
import { intersectTankSegment, HitFacet } from '../sim/hittest';
import { EntityState, TankId } from './protocol';
import { Particles } from '../effects/Particles';
import { clamp, lerp } from '../utils/math';

interface Snap {
  time: number; // server time, ms
  p: THREE.Vector3;
  q: THREE.Quaternion;
  ty: number;
  gp: number;
  vl: number;
  vr: number;
  mg: number;
}

const SNAP_POOL = 32;

export class RemoteTank {
  readonly spec: TankSpec;
  readonly model: TankModelLike;
  readonly tracks: Tracks;
  readonly materials: TankMaterials;

  /** Marks this as a network ghost for Projectiles hit claims. */
  readonly netId: string;

  name: string;
  alive = true;
  hp: number;

  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);

  /** Interpolated track speeds, exposed for audio/effects. */
  speedL = 0;
  speedR = 0;

  private readonly buffer: Snap[] = [];
  private distL = 0;
  private distR = 0;
  private turretYaw = 0;
  private readonly restWheelY: number[] = [];
  private dustAcc = 0;
  private exhaustAcc = 0;
  private mgBits = 0;
  private mgAcc = 0;

  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  private nameTag!: THREE.Sprite;

  constructor(
    scene: THREE.Scene,
    id: string,
    name: string,
    tank: TankId,
    private readonly particles: Particles,
    readonly isAI = false,
  ) {
    this.netId = id;
    this.name = name;
    this.spec = SPECS[tank];
    this.hp = this.spec.hp;
    this.materials = createTankMaterials(this.spec.camoScheme);
    this.model = this.spec.id === 'tiger' ? new TigerModel(this.materials) : new T34Model(this.materials);
    this.tracks = new Tracks(this.spec, this.model.root, this.materials.track);
    scene.add(this.model.root);

    const restY = this.spec.hardpointY - this.spec.suspensionRest + 0.11;
    for (let i = 0; i < this.spec.wheelAxlesZ.length; i++) this.restWheelY.push(restY);
    for (const w of this.model.wheelsLeft) w.position.y = restY;
    for (const w of this.model.wheelsRight) w.position.y = restY;

    this.buildNameTag();
  }

  /** Floating name above the turret (canvas sprite, occluded by terrain). */
  private buildNameTag(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 112;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '600 52px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(10,10,6,0.9)';
    ctx.strokeText(this.name, 256, 58, 490);
    ctx.fillStyle = this.isAI ? '#ffd27a' : '#f0ead0';
    ctx.fillText(this.name, 256, 58, 490);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    this.nameTag = new THREE.Sprite(mat);
    this.nameTag.center.set(0.5, 0);
    this.nameTag.position.set(0, this.spec.hullTopY + this.spec.hitbox.turretH + 1.15, 0);
    this.model.root.add(this.nameTag);
  }

  /** Feed a snapshot (server time in ms). */
  push(time: number, s: EntityState): void {
    const snap: Snap =
      this.buffer.length >= SNAP_POOL
        ? this.buffer.shift()!
        : { time: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), ty: 0, gp: 0, vl: 0, vr: 0, mg: 0 };
    snap.time = time;
    snap.p.set(s.p[0], s.p[1], s.p[2]);
    snap.q.set(s.q[0], s.q[1], s.q[2], s.q[3]);
    snap.ty = s.ty;
    snap.gp = s.gp;
    snap.vl = s.vl;
    snap.vr = s.vr;
    snap.mg = s.mg;

    // teleport (respawn): drop history so we snap instead of sweeping
    const last = this.buffer[this.buffer.length - 1];
    if (last && last.p.distanceTo(snap.p) > 15) this.buffer.length = 0;
    this.buffer.push(snap);
  }

  /** Advance to render time (server clock, ms). */
  update(dt: number, renderTime: number, cameraPos?: THREE.Vector3): void {
    if (cameraPos) {
      const d = cameraPos.distanceTo(this.position);
      // roughly constant on-screen size, readable 8–320 m, hidden beyond
      this.nameTag.visible = d < 320;
      const s = Math.min(Math.max(d, 8), 220) * 0.028;
      this.nameTag.scale.set(s * (512 / 112), s, 1);
    }
    const buf = this.buffer;
    if (buf.length === 0) return;

    // find bracketing snapshots
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].time <= renderTime && buf[i + 1].time >= renderTime) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }
    if (renderTime <= buf[0].time) {
      a = b = buf[0];
    } else if (renderTime >= buf[buf.length - 1].time) {
      a = b = buf[buf.length - 1]; // starve: hold last (brief extrapolation skipped)
    }
    const span = Math.max(1, b.time - a.time);
    const t = clamp((renderTime - a.time) / span, 0, 1);

    const root = this.model.root;
    root.position.copy(a.p).lerp(b.p, t);
    root.quaternion.copy(a.q).slerp(b.q, t);
    this.position.copy(root.position);
    this.forward.set(0, 0, 1).applyQuaternion(root.quaternion);

    this.turretYaw = lerpAngle(a.ty, b.ty, t);
    this.model.turretPivot.rotation.y = this.turretYaw;
    this.model.gunPivot.rotation.x = -lerpAngle(a.gp, b.gp, t);

    this.speedL = lerp(a.vl, b.vl, t);
    this.speedR = lerp(a.vr, b.vr, t);
    this.mgBits = b.mg;

    // running gear + track scroll from interpolated speeds
    this.distL += this.speedL * dt;
    this.distR += this.speedR * dt;
    const spinL = this.distL / this.spec.wheelRadius;
    const spinR = this.distR / this.spec.wheelRadius;
    for (const w of this.model.wheelsLeft) w.rotation.x = spinL;
    for (const w of this.model.wheelsRight) w.rotation.x = spinR;
    const sprocketR = this.spec.sprocket.r + this.spec.trackThickness / 2;
    const idlerR = this.spec.idler.r + this.spec.trackThickness / 2;
    this.model.sprockets[0].rotation.x = this.distL / sprocketR;
    this.model.sprockets[1].rotation.x = this.distR / sprocketR;
    this.model.idlers[0].rotation.x = this.distL / idlerR;
    this.model.idlers[1].rotation.x = this.distR / idlerR;
    this.tracks.update(dt, this.speedL, this.speedR, this.restWheelY, this.restWheelY);

    if (this.alive) {
      this.emitDust(dt);
      this.emitExhaust(dt);
      this.emitMG(dt);
    }
  }

  /** Shells test against ghosts exactly like against local tanks. */
  intersectSegment(a: THREE.Vector3, b: THREE.Vector3): { point: THREE.Vector3; facet: HitFacet } | null {
    return intersectTankSegment(
      a, b,
      { position: this.position, quaternion: this.model.root.quaternion, turretYaw: this.turretYaw },
      this.spec.hitbox,
    );
  }

  setDestroyed(destroyed: boolean): void {
    if (destroyed === !this.alive) return;
    this.alive = !destroyed;
    this.nameTag.material.opacity = destroyed ? 0.35 : 1;
    for (const mat of Object.values(this.materials)) {
      const m = mat as THREE.MeshStandardMaterial;
      if (destroyed) {
        m.color.multiplyScalar(0.32);
        m.roughness = 1;
      } else {
        m.color.multiplyScalar(1 / 0.32);
        m.roughness = m.roughness === 1 ? 0.8 : m.roughness;
      }
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.model.root);
  }

  /* ------------------------------------------------------------------ */

  private emitDust(dt: number): void {
    const speed = Math.max(Math.abs(this.speedL), Math.abs(this.speedR));
    const intensity = clamp((speed - 0.5) * 0.12 + Math.abs(this.speedL - this.speedR) * 0.2, 0, 1.3);
    if (intensity < 0.06) return;
    this.dustAcc += dt * 30;
    if (this.dustAcc < 1) return;
    this.dustAcc = 0;
    for (const side of [1, -1] as const) {
      const v = side === 1 ? this.speedL : this.speedR;
      const rearZ = v >= 0 ? -this.spec.hitbox.halfL * 0.8 : this.spec.hitbox.halfL * 0.8;
      this.tmp
        .set(side * this.spec.trackCenterX, this.spec.hullBottomY - 0.35, rearZ)
        .applyQuaternion(this.model.root.quaternion)
        .add(this.position);
      this.tmpB.copy(this.forward).multiplyScalar(-Math.sign(v) || -1);
      this.particles.trackDust(this.tmp, this.tmpB, intensity);
    }
  }

  private emitExhaust(dt: number): void {
    const load = clamp(Math.max(Math.abs(this.speedL), Math.abs(this.speedR)) / 8, 0.15, 1);
    this.exhaustAcc += dt * (5 + load * 16);
    while (this.exhaustAcc >= 1) {
      this.exhaustAcc -= 1;
      for (const pipe of this.model.exhausts) {
        pipe.getWorldPosition(this.tmp);
        this.particles.exhaustPuff(this.tmp, load);
      }
    }
  }

  private emitMG(dt: number): void {
    if (!this.mgBits) return;
    this.mgAcc += dt * 14;
    if (this.mgAcc < 1) return;
    this.mgAcc = 0;
    if (this.mgBits & 1) {
      this.model.coaxMuzzle.getWorldPosition(this.tmp);
      this.model.recoilGroup.getWorldDirection(this.tmpB);
      this.particles.mgFlash(this.tmp, this.tmpB);
    }
    if (this.mgBits & 2) {
      this.model.hullMGMuzzle.getWorldPosition(this.tmp);
      this.tmpB.copy(this.forward);
      this.particles.mgFlash(this.tmp, this.tmpB);
    }
  }
}

/** Angle lerp along the shortest arc. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
