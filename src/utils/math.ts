/* ---------------------------------------------------------------------------
 * Small math helpers shared across the sim.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential smoothing.
 * Moves `current` toward `target`; `lambda` ~ "speed" (higher = snappier).
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Shortest signed angular difference a→b, result in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Move angle `current` toward `target` by at most `maxStep`, along the shortest arc. */
export function rotateTowards(current: number, target: number, maxStep: number): number {
  const d = angleDelta(current, target);
  return current + clamp(d, -maxStep, maxStep);
}

/* ---- three <-> cannon conversions (no allocation when `out` given) ---- */

export function toThreeV(v: CANNON.Vec3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.y, v.z);
}

export function toCannonV(v: THREE.Vector3, out = new CANNON.Vec3()): CANNON.Vec3 {
  out.set(v.x, v.y, v.z);
  return out;
}

export function toThreeQ(q: CANNON.Quaternion, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.set(q.x, q.y, q.z, q.w);
}
