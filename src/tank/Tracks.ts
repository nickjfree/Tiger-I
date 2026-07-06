/* ---------------------------------------------------------------------------
 * Segmented caterpillar tracks (spec-driven — works for any vehicle).
 *
 * Each side is one InstancedMesh of individual links placed along a closed
 * path rebuilt every frame from the *current* road-wheel heights, so the
 * track visually conforms to terrain exactly like the suspension does:
 *
 *   · bottom run  — hugs the wheel bottoms (terrain-conforming)
 *   · front ring  — wrap arc (Tiger: drive sprocket · T-34: idler)
 *   · top run     — rides on the wheel tops with sag between supports
 *   · rear ring   — wrap arc (Tiger: idler · T-34: drive sprocket)
 *
 * Links are distributed by arc length and scrolled with the track's actual
 * ground speed, so contact links appear stationary relative to the ground.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TankSpec, RingSpec } from './config';

interface PathPoint {
  z: number;
  y: number;
}

const WRAP_STEP = (15 * Math.PI) / 180;

/** Single track link: plate + cleats + central guide horn. */
function makeLinkGeometry(spec: TankSpec): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const plate = new THREE.BoxGeometry(spec.trackWidth - 0.02, 0.045, spec.trackLinkPitch - 0.012);
  parts.push(plate);

  for (const zc of [-spec.trackLinkPitch * 0.27, spec.trackLinkPitch * 0.27]) {
    const cleat = new THREE.BoxGeometry(spec.trackWidth - 0.02, 0.018, 0.028);
    cleat.translate(0, 0.031, zc);
    parts.push(cleat);
  }

  const horn = new THREE.BoxGeometry(0.05, 0.095, 0.06);
  horn.translate(0, 0.068, 0);
  parts.push(horn);

  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return merged;
}

class TrackSide {
  readonly mesh: THREE.InstancedMesh;
  private offset = 0;
  private readonly points: PathPoint[] = [];
  private readonly cumLen: number[] = [];
  private totalLen = 0;

  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpS = new THREE.Vector3(1, 1, 1);
  private readonly xAxis = new THREE.Vector3(1, 0, 0);

  private readonly frontRing: RingSpec;
  private readonly rearRing: RingSpec;
  private readonly halfT: number;

  constructor(
    private readonly spec: TankSpec,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    private readonly sideX: number,
    linkCount: number,
  ) {
    // whichever of sprocket/idler sits forward wraps the front of the loop
    this.frontRing = spec.sprocket.z > 0 ? spec.sprocket : spec.idler;
    this.rearRing = spec.sprocket.z > 0 ? spec.idler : spec.sprocket;
    this.halfT = spec.trackThickness / 2;

    this.mesh = new THREE.InstancedMesh(geometry, material, linkCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // hull-local instances; cheap to always draw
  }

  /** Rebuild the closed path from current wheel center heights (front→rear). */
  buildPath(wheelY: number[]): void {
    const pts = this.points;
    pts.length = 0;

    const r = this.spec.wheelRadius;
    const axles = this.spec.wheelAxlesZ;
    const fr = this.frontRing;
    const rr = this.rearRing;
    const frR = fr.r + this.halfT;
    const rrR = rr.r + this.halfT;

    // -- bottom run: rear wheel → front wheel along the wheel bottoms --
    for (let i = axles.length - 1; i >= 0; i--) {
      const y = wheelY[i] - r - this.halfT;
      pts.push({ z: axles[i], y });
      if (i > 0) {
        const yn = wheelY[i - 1] - r - this.halfT;
        pts.push({ z: (axles[i] + axles[i - 1]) / 2, y: Math.min(y, yn) - 0.004 });
      }
    }

    // -- front ring wrap. angle a: -90°=bottom, 0=front, +90°=top --
    for (let a = -Math.PI * 0.55; a <= Math.PI / 2 + 1e-4; a += WRAP_STEP) {
      pts.push({ z: fr.z + Math.cos(a) * frR, y: fr.y + Math.sin(a) * frR });
    }

    // -- top run: front wheel top → rear wheel top, with sag between wheels --
    for (let i = 0; i < axles.length; i++) {
      const y = wheelY[i] + r + this.halfT;
      pts.push({ z: axles[i], y });
      if (i < axles.length - 1) {
        const yn = wheelY[i + 1] + r + this.halfT;
        pts.push({ z: (axles[i] + axles[i + 1]) / 2, y: (y + yn) / 2 - 0.022 });
      }
    }

    // -- rear ring wrap: top → rear → bottom --
    for (let a = Math.PI / 2; a <= Math.PI * 1.5 + 1e-4; a += WRAP_STEP) {
      pts.push({ z: rr.z - Math.cos(Math.PI - a) * rrR, y: rr.y + Math.sin(a) * rrR });
    }

    // cumulative arc length (closed loop)
    const cum = this.cumLen;
    cum.length = 0;
    let len = 0;
    cum.push(0);
    for (let i = 1; i <= pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i % pts.length];
      len += Math.hypot(b.z - a.z, b.y - a.y);
      cum.push(len);
    }
    this.totalLen = len;
  }

  get pathLength(): number {
    return this.totalLen;
  }

  /** Sample position + tangent angle at arc distance s. */
  private sample(s: number, out: { z: number; y: number; ang: number }): void {
    const pts = this.points;
    const cum = this.cumLen;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = pts[lo % pts.length];
    const b = pts[(lo + 1) % pts.length];
    const segLen = cum[lo + 1] - cum[lo] || 1;
    const t = (s - cum[lo]) / segLen;
    out.z = a.z + (b.z - a.z) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.ang = Math.atan2(b.y - a.y, b.z - a.z);
  }

  update(dt: number, groundSpeed: number, wheelY: number[]): void {
    this.buildPath(wheelY);

    // Ground-contact links stay put in world space while the hull moves
    // forward, i.e. they travel rearward along the loop (bottom run is
    // parameterized rear→front) — hence the negative sign.
    this.offset = (((this.offset - groundSpeed * dt) % this.totalLen) + this.totalLen) % this.totalLen;

    const n = this.mesh.count;
    const spacing = this.totalLen / n;
    const smp = { z: 0, y: 0, ang: 0 };
    for (let i = 0; i < n; i++) {
      const s = (this.offset + i * spacing) % this.totalLen;
      this.sample(s, smp);
      // rotation about X by −tangentAngle keeps guide horns facing the wheels
      this.tmpQ.setFromAxisAngle(this.xAxis, -smp.ang);
      this.tmpP.set(this.sideX, smp.y, smp.z);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.mesh.setMatrixAt(i, this.tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class Tracks {
  private readonly left: TrackSide;
  private readonly right: TrackSide;

  constructor(spec: TankSpec, parent: THREE.Object3D, material: THREE.Material) {
    const geo = makeLinkGeometry(spec);

    // measure the rest path to pick a constant link count
    const restY = new Array(spec.wheelAxlesZ.length).fill(
      spec.hardpointY - spec.suspensionRest + 0.11,
    );
    const probe = new TrackSide(spec, geo, material, spec.trackCenterX, 8);
    probe.buildPath(restY);
    const linkCount = Math.round(probe.pathLength / spec.trackLinkPitch);
    probe.mesh.dispose();

    this.left = new TrackSide(spec, geo, material, spec.trackCenterX, linkCount);
    this.right = new TrackSide(spec, geo, material, -spec.trackCenterX, linkCount);
    parent.add(this.left.mesh, this.right.mesh);
  }

  update(
    dt: number,
    leftSpeed: number,
    rightSpeed: number,
    wheelYLeft: number[],
    wheelYRight: number[],
  ): void {
    this.left.update(dt, leftSpeed, wheelYLeft);
    this.right.update(dt, rightSpeed, wheelYRight);
  }
}
