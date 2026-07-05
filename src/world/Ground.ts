/* ---------------------------------------------------------------------------
 * Unified ground sampler: terrain heightfield + solid props (rock domes).
 *
 * Everything that "stands on the ground" — suspension stations, track paths,
 * shells, camera clamping, debris — samples THIS instead of raw Terrain, so
 * the tank's suspension and tracks conform to obstacles exactly the way they
 * conform to hills.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Terrain } from './Terrain';
import { Props } from './Props';

/** Minimal interface consumed by physics / projectiles / camera. */
export interface GroundLike {
  readonly size: number;
  getHeight(x: number, z: number): number;
  getNormal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
}

export class Ground implements GroundLike {
  readonly size: number;

  constructor(
    private readonly terrain: Terrain,
    private readonly props: Props,
  ) {
    this.size = terrain.size;
  }

  getHeight(x: number, z: number): number {
    const h = this.terrain.getHeight(x, z);
    const rock = this.props.rockBumpAt(x, z);
    return rock > h ? rock : h;
  }

  getNormal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.45;
    const hx = this.getHeight(x + e, z) - this.getHeight(x - e, z);
    const hz = this.getHeight(x, z + e) - this.getHeight(x, z - e);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }
}
