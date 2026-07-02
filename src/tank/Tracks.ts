/* ---------------------------------------------------------------------------
 * Segmented caterpillar tracks.
 *
 * Each side is one InstancedMesh of ~110 individual links placed along a
 * closed path that is rebuilt every frame from the *current* road-wheel
 * heights, so the track visually conforms to terrain exactly like the
 * suspension does:
 *
 *   · bottom run  — hugs the wheel bottoms (terrain-conforming)
 *   · sprocket    — wrap arc at the front drive wheel
 *   · top run     — rides on the wheel tops with catenary-ish sag between
 *   · idler       — wrap arc at the rear
 *
 * Links are distributed by arc length and scrolled with the track's actual
 * ground speed, so link spacing stays constant and motion is physically
 * consistent (contact links appear stationary relative to the ground).
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TIGER } from './config';

interface PathPoint {
  z: number;
  y: number;
}

const HALF_T = TIGER.trackThickness / 2;
const WRAP_STEP = (15 * Math.PI) / 180;

/** Single Kgs 63/725/130 link: plate + cleats + central guide horn. */
function makeLinkGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const plate = new THREE.BoxGeometry(TIGER.trackWidth - 0.02, 0.045, TIGER.trackLinkPitch - 0.012);
  parts.push(plate);

  for (const zc of [-0.035, 0.035]) {
    const cleat = new THREE.BoxGeometry(TIGER.trackWidth - 0.02, 0.018, 0.028);
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

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    private readonly sideX: number,
    linkCount: number,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, linkCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // hull-local instances; cheap to always draw
  }

  /** Rebuild the closed path from current wheel center heights (front→rear). */
  private buildPath(wheelY: number[]): void {
    const pts = this.points;
    pts.length = 0;

    const r = TIGER.wheelRadius;
    const axles = TIGER.wheelAxlesZ;
    const sp = TIGER.sprocket;
    const id = TIGER.idler;
    const spR = sp.r + HALF_T;
    const idR = id.r + HALF_T;

    // -- bottom run: rear wheel → front wheel along the wheel bottoms --
    for (let i = axles.length - 1; i >= 0; i--) {
      const y = wheelY[i] - r - HALF_T;
      pts.push({ z: axles[i], y });
      if (i > 0) {
        const yn = wheelY[i - 1] - r - HALF_T;
        pts.push({ z: (axles[i] + axles[i - 1]) / 2, y: Math.min(y, yn) - 0.004 });
      }
    }

    // -- sprocket wrap (front). angle a: -90°=bottom, 0=front, +90°=top --
    for (let a = -Math.PI * 0.55; a <= Math.PI / 2 + 1e-4; a += WRAP_STEP) {
      pts.push({ z: sp.z + Math.cos(a) * spR, y: sp.y + Math.sin(a) * spR });
    }

    // -- top run: front wheel top → rear wheel top, with sag between wheels --
    for (let i = 0; i < axles.length; i++) {
      const y = wheelY[i] + r + HALF_T;
      pts.push({ z: axles[i], y });
      if (i < axles.length - 1) {
        const yn = wheelY[i + 1] + r + HALF_T;
        pts.push({ z: (axles[i] + axles[i + 1]) / 2, y: (y + yn) / 2 - 0.022 });
      }
    }

    // -- idler wrap (rear): top → rear → bottom --
    for (let a = Math.PI / 2; a <= Math.PI * 1.5 + 1e-4; a += WRAP_STEP) {
      pts.push({ z: id.z - Math.cos(Math.PI - a) * idR, y: id.y + Math.sin(a) * idR });
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

  /** Sample position + tangent angle at arc distance s. */
  private sample(s: number, out: { z: number; y: number; ang: number }): void {
    const pts = this.points;
    const cum = this.cumLen;
    // binary search for the segment containing s
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

    // When the hull drives forward, ground-contact links stay put in world
    // space, i.e. they move rearward along the loop (whose bottom run is
    // parameterized rear→front) — hence the negative sign.
    this.offset = (((this.offset - groundSpeed * dt) % this.totalLen) + this.totalLen) % this.totalLen;

    const n = this.mesh.count;
    const spacing = this.totalLen / n;
    const smp = { z: 0, y: 0, ang: 0 };
    for (let i = 0; i < n; i++) {
      const s = (this.offset + i * spacing) % this.totalLen;
      this.sample(s, smp);
      // Rotation about X by −tangentAngle keeps the guide horns facing the
      // wheels on both the bottom and return runs (see derivation in Git
      // history / README).
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

  constructor(parent: THREE.Object3D, material: THREE.Material) {
    const geo = makeLinkGeometry();

    // Estimate rest path length to pick a constant link count (~real 96/side)
    const restY = new Array(TIGER.wheelAxlesZ.length).fill(-0.8);
    const probe = new TrackSide(geo, material, TIGER.trackCenterX, 8);
    // @ts-expect-error – reuse private path builder for the initial measure
    probe.buildPath(restY);
    // @ts-expect-error – read measured length
    const restLen: number = probe.totalLen;
    probe.mesh.dispose();

    const linkCount = Math.round(restLen / TIGER.trackLinkPitch);
    this.left = new TrackSide(geo, material, TIGER.trackCenterX, linkCount);
    this.right = new TrackSide(geo, material, -TIGER.trackCenterX, linkCount);
    parent.add(this.left.mesh, this.right.mesh);
  }

  /**
   * @param leftSpeed/rightSpeed  actual per-side ground speeds (m/s)
   * @param wheelYLeft/right      current wheel center heights, hull-local
   */
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
