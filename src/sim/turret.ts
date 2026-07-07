/* ---------------------------------------------------------------------------
 * Minimal turret kinematics shared with the game server.
 *
 * The server's headless AI tank has no THREE model hierarchy, so gun world
 * direction and muzzle position are computed analytically from the spec's
 * pivot offsets (matching TigerModel / T34Model).
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TankSpec } from '../tank/config';
import { clamp, rotateTowards } from '../utils/math';

export interface TurretState {
  yaw: number; // hull-local
  pitch: number; // positive = elevated
}

/** Gun pivot offsets per vehicle (mirrors the visual models). */
export function gunGeometry(spec: TankSpec): { pivotY: number; pivotZ: number; muzzleLen: number } {
  return spec.id === 'tiger'
    ? { pivotY: 0.37, pivotZ: 0.88, muzzleLen: 4.68 }
    : { pivotY: 0.3, pivotZ: 0.5, muzzleLen: 4.44 };
}

const aimLocal = new THREE.Vector3();
const invQ = new THREE.Quaternion();

/** Rate-limited chase of a world aim direction (same math as Gun.update). */
export function updateTurretAim(
  spec: TankSpec,
  hullQuat: THREE.Quaternion,
  aimDirWorld: THREE.Vector3,
  dt: number,
  st: TurretState,
): void {
  const g = spec.gun;
  invQ.copy(hullQuat).invert();
  aimLocal.copy(aimDirWorld).applyQuaternion(invQ);
  const yawTarget = Math.atan2(aimLocal.x, aimLocal.z);
  const pitchTarget = Math.atan2(aimLocal.y, Math.hypot(aimLocal.x, aimLocal.z));
  st.yaw = rotateTowards(st.yaw, yawTarget, g.traverseRate * dt);
  st.pitch = rotateTowards(
    st.pitch,
    clamp(pitchTarget, -g.depressionMax, g.elevationMax),
    g.elevateRate * dt,
  );
}

const yawQ = new THREE.Quaternion();
const pitchQ = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** World direction the gun points at. */
export function gunWorldDir(
  hullQuat: THREE.Quaternion,
  st: TurretState,
  out: THREE.Vector3,
): THREE.Vector3 {
  yawQ.setFromAxisAngle(Y_AXIS, st.yaw);
  pitchQ.setFromAxisAngle(X_AXIS, -st.pitch);
  return out.set(0, 0, 1).applyQuaternion(pitchQ).applyQuaternion(yawQ).applyQuaternion(hullQuat);
}

const local = new THREE.Vector3();

/** World muzzle position. */
export function muzzleWorldPos(
  spec: TankSpec,
  hullPos: THREE.Vector3,
  hullQuat: THREE.Quaternion,
  st: TurretState,
  out: THREE.Vector3,
): THREE.Vector3 {
  const gg = gunGeometry(spec);
  yawQ.setFromAxisAngle(Y_AXIS, st.yaw);
  pitchQ.setFromAxisAngle(X_AXIS, -st.pitch);
  local.set(0, 0, gg.muzzleLen).applyQuaternion(pitchQ);
  local.y += gg.pivotY;
  local.z += gg.pivotZ;
  local.applyQuaternion(yawQ);
  local.y += spec.hullTopY;
  local.z += spec.turretRingZ;
  return out.copy(local).applyQuaternion(hullQuat).add(hullPos);
}
