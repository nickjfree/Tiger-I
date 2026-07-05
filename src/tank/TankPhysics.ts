/* ---------------------------------------------------------------------------
 * Rigid-body tank physics (cannon-es).
 *
 * The hull is a single dynamic body. Instead of colliding a box against a
 * heightfield (jittery for a 57 t vehicle), we run a raycast-vehicle-style
 * model: 16 suspension stations (8 per side, matching the Tiger's axles)
 * sample the analytic terrain height and apply spring/damper forces, plus
 * longitudinal drive & lateral friction forces at each contact.
 *
 * Differential steering falls out naturally: each side chases its own target
 * track speed, so opposite targets produce a neutral (pivot) turn — the real
 * Tiger's regenerative steering could do this too.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GroundLike } from '../world/Ground';
import { TIGER } from './config';
import { clamp, damp } from '../utils/math';

export interface DriveInput {
  throttle: number; // -1..1
  steer: number; // -1..1, positive = right
  brake: boolean;
}

interface Station {
  side: -1 | 1; // 1 = left (+X), -1 = right (−X)
  local: CANNON.Vec3; // hardpoint in body frame
  compression: number; // physics compression this step (m)
  visualCompression: number; // smoothed for rendering
  contact: boolean;
}

const SUBSTEP = 1 / 120;

export class TankPhysics {
  readonly world: CANNON.World;
  readonly body: CANNON.Body;
  readonly stations: Station[] = [];

  /** Actual forward speed of each track over the ground (m/s). */
  trackSpeedLeft = 0;
  trackSpeedRight = 0;
  /** Commanded track speeds (for slip/dust/audio). */
  targetSpeedLeft = 0;
  targetSpeedRight = 0;

  /** Smoothed "engine load" 0..1 for audio/exhaust. */
  engineLoad = 0;

  private accumulator = 0;

  // scratch objects (avoid per-frame allocation)
  private readonly tmpP = new CANNON.Vec3();
  private readonly tmpR = new CANNON.Vec3();
  private readonly tmpV = new CANNON.Vec3();
  private readonly tmpF = new CANNON.Vec3();
  private readonly tmpFwd = new CANNON.Vec3();
  private readonly tmpUp = new CANNON.Vec3();
  private readonly tmpN = new THREE.Vector3();

  constructor(private readonly terrain: GroundLike) {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
    this.world.allowSleep = false;

    // Box shape only provides sensible inertia — terrain contact is handled
    // by the suspension + belly penalty forces below.
    const shape = new CANNON.Box(new CANNON.Vec3(1.6, 0.55, 3.0));
    this.body = new CANNON.Body({
      mass: TIGER.mass,
      shape,
      position: new CANNON.Vec3(0, terrain.getHeight(0, 0) + TIGER.originHeight + 0.3, 0),
      linearDamping: 0.02,
      angularDamping: 0.35,
    });
    this.world.addBody(this.body);

    for (const side of [1, -1] as const) {
      for (const z of TIGER.wheelAxlesZ) {
        this.stations.push({
          side,
          local: new CANNON.Vec3(side * TIGER.trackCenterX, TIGER.hardpointY, z),
          compression: 0,
          visualCompression: 0.1,
          contact: false,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */

  update(dt: number, input: DriveInput): void {
    this.accumulator = Math.min(this.accumulator + dt, 0.06);
    while (this.accumulator >= SUBSTEP) {
      this.substep(SUBSTEP, input);
      this.accumulator -= SUBSTEP;
    }

    // Smooth visual suspension so wheel meshes don't buzz at 120 Hz
    for (const s of this.stations) {
      s.visualCompression = damp(s.visualCompression, s.compression, 18, dt);
    }

    // Engine load estimate for audio/exhaust
    const demand = Math.max(Math.abs(input.throttle), Math.abs(input.steer) * 0.7);
    this.engineLoad = damp(this.engineLoad, demand, 2.5, dt);
  }

  private substep(h: number, input: DriveInput): void {
    const body = this.body;
    const q = body.quaternion;

    // Basis vectors in world space
    q.vmult(new CANNON.Vec3(0, 0, 1), this.tmpFwd);
    q.vmult(new CANNON.Vec3(0, 1, 0), this.tmpUp);
    const fwd = this.tmpFwd;
    const up = this.tmpUp;

    // ---- commanded track speeds (differential steering) ----
    const base =
      input.throttle >= 0
        ? input.throttle * TIGER.maxForwardSpeed
        : input.throttle * TIGER.maxReverseSpeed;
    // steering: right turn (steer>0) → left (+X) track speeds up
    this.targetSpeedLeft = input.brake ? 0 : base + input.steer * TIGER.steerSpeed;
    this.targetSpeedRight = input.brake ? 0 : base - input.steer * TIGER.steerSpeed;

    // ---- actual per-side ground speeds ----
    const vFwd = body.velocity.dot(fwd);
    const yawRate = body.angularVelocity.dot(up);
    this.trackSpeedLeft = vFwd - yawRate * TIGER.trackCenterX;
    this.trackSpeedRight = vFwd + yawRate * TIGER.trackCenterX;

    // ---- suspension + traction per station ----
    for (const s of this.stations) {
      q.vmult(s.local, this.tmpR); // world-oriented offset from COM
      const px = body.position.x + this.tmpR.x;
      const py = body.position.y + this.tmpR.y;
      const pz = body.position.z + this.tmpR.z;

      const ground = this.terrain.getHeight(px, pz);
      const dist = py - ground;
      // contact radius includes the track shoe the wheel rides on
      let comp = TIGER.suspensionRest + TIGER.wheelRadius + TIGER.trackShoe - dist;

      if (comp <= 0) {
        s.compression = 0;
        s.contact = false;
        continue;
      }
      s.contact = true;

      // velocity of the hardpoint (v + ω × r)
      body.angularVelocity.cross(this.tmpR, this.tmpV);
      this.tmpV.vadd(body.velocity, this.tmpV);

      // -- spring / damper along world up --
      let springComp = comp;
      let bumpStop = 0;
      if (comp > TIGER.suspensionTravel) {
        bumpStop = (comp - TIGER.suspensionTravel) * TIGER.springK * 8;
        springComp = TIGER.suspensionTravel;
      }
      let fy = TIGER.springK * springComp + bumpStop - TIGER.springC * this.tmpV.y;
      fy = clamp(fy, 0, 1.4e6);
      this.tmpF.set(0, fy, 0);
      body.applyForce(this.tmpF, this.tmpR);
      s.compression = Math.min(comp, TIGER.suspensionTravel + 0.1);

      // -- traction in the local ground plane --
      const n = this.terrain.getNormal(px, pz, this.tmpN);
      // forward direction projected onto ground plane
      const fDotN = fwd.x * n.x + fwd.y * n.y + fwd.z * n.z;
      let fx = fwd.x - n.x * fDotN;
      let fyp = fwd.y - n.y * fDotN;
      let fz = fwd.z - n.z * fDotN;
      const fl = Math.hypot(fx, fyp, fz) || 1;
      fx /= fl;
      fyp /= fl;
      fz /= fl;
      // lateral = n × forward
      const sx = n.y * fz - n.z * fyp;
      const sy = n.z * fx - n.x * fz;
      const sz = n.x * fyp - n.y * fx;

      const vLong = this.tmpV.x * fx + this.tmpV.y * fyp + this.tmpV.z * fz;
      const vLat = this.tmpV.x * sx + this.tmpV.y * sy + this.tmpV.z * sz;

      const maxLong = input.brake ? TIGER.brakeTraction : TIGER.maxTraction;

      // Drive force is split into two controllers:
      //  - common mode: chases the throttle's base speed; limited by engine
      //    power (full tractive effort only at crawl — a 700 hp engine can't
      //    accelerate 57 t like a car). Braking is exempt (tracks, not engine).
      //  - differential mode: chases the *speed difference* commanded by
      //    steering. The Tiger's regenerative steering gear transferred power
      //    from the slowed track to the sped-up one, so this part is roughly
      //    power-neutral and is NOT capped by engine power. It also acts as
      //    yaw damping when no steering is commanded.
      let fBase = clamp(TIGER.driveGain * ((input.brake ? 0 : base) - vFwd), -maxLong, maxLong);
      if (fBase * vFwd > 0) {
        const perStation = TIGER.enginePower / this.stations.length;
        const powerCap = perStation / Math.max(Math.abs(vFwd), 0.7);
        fBase = clamp(fBase, -powerCap, powerCap);
      }
      const diffTarget = input.brake ? 0 : s.side * input.steer * TIGER.steerSpeed;
      const vDiff = vLong - vFwd; // yaw-induced speed at this station
      const fSteer = clamp(TIGER.driveGain * (diffTarget - vDiff), -TIGER.maxTraction, TIGER.maxTraction);

      const fLong = clamp(fBase + fSteer, -maxLong, maxLong);
      const fLat = clamp(-TIGER.lateralGain * vLat, -TIGER.maxLateral, TIGER.maxLateral);

      this.tmpF.set(fx * fLong + sx * fLat, fyp * fLong + sy * fLat, fz * fLong + sz * fLat);
      body.applyForce(this.tmpF, this.tmpR);
    }

    // ---- belly penalty contacts (nose digging into steep ground) ----
    for (const cx of [-0.95, 0.95]) {
      for (const cz of [-2.6, 2.6]) {
        this.tmpP.set(cx, TIGER.hullBottomY + 0.05, cz);
        q.vmult(this.tmpP, this.tmpR);
        const px = body.position.x + this.tmpR.x;
        const py = body.position.y + this.tmpR.y;
        const pz = body.position.z + this.tmpR.z;
        const ground = this.terrain.getHeight(px, pz);
        const pen = ground - py;
        if (pen > 0) {
          body.angularVelocity.cross(this.tmpR, this.tmpV);
          this.tmpV.vadd(body.velocity, this.tmpV);
          const f = clamp(pen * 2.5e6 - this.tmpV.y * 8e4, 0, 2e6);
          this.tmpF.set(0, f, 0);
          body.applyForce(this.tmpF, this.tmpR);
        }
      }
    }

    // ---- soft world boundary ----
    const half = this.terrain.size * 0.5 - 14;
    const bp = body.position;
    if (Math.abs(bp.x) > half) {
      body.applyForce(new CANNON.Vec3(-Math.sign(bp.x) * 4e5, 0, 0), CANNON.Vec3.ZERO);
    }
    if (Math.abs(bp.z) > half) {
      body.applyForce(new CANNON.Vec3(0, 0, -Math.sign(bp.z) * 4e5), CANNON.Vec3.ZERO);
    }

    this.world.step(h);
  }

  /* ------------------------------------------------------------------ */

  /** Signed hull speed in km/h (positive forward). */
  get speedKmh(): number {
    this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1), this.tmpV);
    return this.body.velocity.dot(this.tmpV) * 3.6;
  }

  /** Recover from a rollover: keep yaw, drop upright just above ground. */
  resetUpright(): void {
    const p = this.body.position;
    const fwd = new CANNON.Vec3();
    this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1), fwd);
    const yaw = Math.atan2(fwd.x, fwd.z);
    this.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
    p.y = this.terrain.getHeight(p.x, p.z) + TIGER.originHeight + 0.6;
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
  }

  /** Fire recoil: horizontal impulse opposite the shot direction. */
  applyRecoilImpulse(dirWorld: THREE.Vector3, impulse: number): void {
    const j = new CANNON.Vec3(-dirWorld.x * impulse, 0, -dirWorld.z * impulse);
    // applied slightly above COM so the hull rocks back believably
    this.body.applyImpulse(j, new CANNON.Vec3(0, 0.8, 0));
  }
}
