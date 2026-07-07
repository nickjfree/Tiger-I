/* ---------------------------------------------------------------------------
 * Pure tank hit-test + armor resolution.
 *
 * Shared between the client (Projectiles vs local Tanks / remote ghosts) and
 * the game server (AI shells vs player transforms, damage authority) so both
 * sides run the exact same geometry and penetration model.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TankSpec, HitboxSpec } from '../tank/config';

export type HitFacet =
  | 'hullFront' | 'hullSide' | 'hullRear'
  | 'turretFront' | 'turretSide' | 'turretRear'
  | 'top';

export interface HitResult {
  type: 'penetration' | 'ricochet';
  facet: HitFacet;
  destroyed: boolean;
  damage: number;
}

export interface TankTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  turretYaw: number;
}

const tmpQ = new THREE.Quaternion();
const localA = new THREE.Vector3();
const localB = new THREE.Vector3();
const dVec = new THREE.Vector3();

/**
 * Swept segment vs hull OBB + turret cylinder.
 * Returns world hit point and the armor facet struck, or null.
 */
export function intersectTankSegment(
  a: THREE.Vector3,
  b: THREE.Vector3,
  tr: TankTransform,
  hb: HitboxSpec,
): { point: THREE.Vector3; facet: HitFacet } | null {
  tmpQ.copy(tr.quaternion).invert();
  localA.copy(a).sub(tr.position).applyQuaternion(tmpQ);
  localB.copy(b).sub(tr.position).applyQuaternion(tmpQ);

  // slab test on a tall box that includes the turret; facet resolved after
  const min = { x: -hb.halfW, y: hb.hullBottomY - 0.35, z: -hb.halfL };
  const max = { x: hb.halfW, y: hb.hullTopY + hb.turretH, z: hb.halfL };
  const d = dVec.copy(localB).sub(localA);
  let tMin = 0;
  let tMax = 1;
  let entryAxis: 'x' | 'y' | 'z' = 'z';
  for (const axis of ['x', 'y', 'z'] as const) {
    const o = localA[axis];
    const dd = d[axis];
    const lo = min[axis];
    const hi = max[axis];
    if (Math.abs(dd) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / dd;
    let t2 = (hi - o) / dd;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tMin) {
      tMin = t1;
      entryAxis = axis;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  const hitLocal = localA.clone().addScaledVector(d, tMin);

  // above the hull roof? only counts if the turret cylinder is struck
  if (hitLocal.y > hb.hullTopY - 0.02) {
    return turretIntersect(localA, d, tr, hb);
  }

  let facet: HitFacet;
  if (entryAxis === 'y') facet = 'top';
  else if (entryAxis === 'x') facet = 'hullSide';
  else facet = d.z < 0 ? 'hullFront' : 'hullRear';

  const point = hitLocal.applyQuaternion(tr.quaternion).add(tr.position);
  return { point, facet };
}

function turretIntersect(
  a: THREE.Vector3,
  d: THREE.Vector3,
  tr: TankTransform,
  hb: HitboxSpec,
): { point: THREE.Vector3; facet: HitFacet } | null {
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + d.x * t;
    const y = a.y + d.y * t;
    const z = a.z + d.z * t;
    if (y < hb.hullTopY - 0.02 || y > hb.hullTopY + hb.turretH + 0.15) continue;
    const dx = x;
    const dz = z - hb.turretZ;
    if (dx * dx + dz * dz > hb.turretR * hb.turretR) continue;

    const dirYaw = Math.atan2(-d.x, -d.z); // bearing the shell came FROM
    let rel = dirYaw - tr.turretYaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    const absRel = Math.abs(rel);
    const facet: HitFacet =
      d.y < -0.55 * Math.hypot(d.x, d.z)
        ? 'top'
        : absRel < (65 * Math.PI) / 180
          ? 'turretFront'
          : absRel < (125 * Math.PI) / 180
            ? 'turretSide'
            : 'turretRear';

    const point = new THREE.Vector3(x, y, z).applyQuaternion(tr.quaternion).add(tr.position);
    return { point, facet };
  }
  return null;
}

export interface PenMeta {
  pen0: number;
  penFalloff: number;
  damage: readonly [number, number];
}

/** Penetration roll vs facet armor. Pure; caller applies HP. */
export function resolvePenetration(
  spec: TankSpec,
  meta: PenMeta,
  facet: HitFacet,
  flightDist: number,
  rand: () => number = Math.random,
): { penetrated: boolean; damage: number } {
  const pen = Math.max(5, meta.pen0 - meta.penFalloff * flightDist);
  const armor = spec.armor[facet];
  const roll = pen * (0.88 + rand() * 0.24);
  if (roll > armor) {
    const dmg = meta.damage[0] + rand() * (meta.damage[1] - meta.damage[0]);
    return { penetrated: true, damage: dmg };
  }
  return { penetrated: false, damage: 0 };
}
