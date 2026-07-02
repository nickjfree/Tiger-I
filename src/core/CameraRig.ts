/* ---------------------------------------------------------------------------
 * Third-person chase camera + gunner sight.
 *
 * Chase mode: mouse orbits the camera around the tank; the turret chases the
 * camera's view direction (War-Thunder style). Wheel zooms.
 * Sight mode (hold RMB): camera locks to the gun's own orientation at the
 * TZF sight position with a narrow FOV — you feel the traverse lag.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Input } from './Input';
import { Terrain } from '../world/Terrain';
import { Tank } from '../tank/Tank';
import { clamp, damp } from '../utils/math';

const SENS = 0.0022;
const CHASE_FOV = 58;
const SIGHT_FOV = 17;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  /** View direction commanded by the mouse — the turret aims at this. */
  readonly aimDir = new THREE.Vector3(0, 0, 1);

  sightMode = false;

  private yaw = Math.PI; // behind the tank, looking forward (+Z)
  private pitch = 0.18;
  private dist = 10.5;

  private shake = 0;

  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly sightPos = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  /** Cameras look down −Z, the gun points along +Z — flip 180° about Y. */
  private readonly flipY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CHASE_FOV, aspect, 0.3, 3200);
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  update(dt: number, input: Input, tank: Tank, terrain: Terrain): void {
    // ---- mouse orbit ----
    const look = input.consumeLook();
    const sens = this.sightMode ? SENS * 0.35 : SENS;
    this.yaw -= look.dx * sens;
    this.pitch = clamp(this.pitch + look.dy * sens, -0.38, 1.15);
    this.dist = clamp(this.dist * Math.pow(1.12, input.consumeWheel()), 5.5, 22);

    this.sightMode = input.sightHeld;

    // commanded view direction (drives the turret in both modes)
    this.aimDir
      .set(-Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch))
      .normalize();

    // ---- shake decay ----
    this.shake = damp(this.shake, 0, 6, dt);
    const shakeX = (Math.random() - 0.5) * this.shake * 0.05;
    const shakeY = (Math.random() - 0.5) * this.shake * 0.05;

    if (this.sightMode) {
      // ---- gunner sight: locked to the gun ----
      tank.model.gunPivot.localToWorld(this.sightPos.set(0.42, 0.42, 0.55));
      this.camera.position.copy(this.sightPos);
      tank.model.gunPivot.getWorldQuaternion(this.tmpQ);
      this.camera.quaternion.copy(this.tmpQ).multiply(this.flipY);
      this.camera.rotateY(shakeX);
      this.camera.rotateX(shakeY);
      this.camera.fov = damp(this.camera.fov, SIGHT_FOV, 10, dt);
    } else {
      // ---- chase orbit ----
      this.target.copy(tank.position).add(this.desired.set(0, 2.5, 0));
      this.desired
        .set(
          Math.sin(this.yaw) * Math.cos(this.pitch),
          Math.sin(this.pitch),
          Math.cos(this.yaw) * Math.cos(this.pitch),
        )
        .multiplyScalar(this.dist)
        .add(this.target);

      // keep the camera above the terrain
      const minY = terrain.getHeight(this.desired.x, this.desired.z) + 0.6;
      if (this.desired.y < minY) this.desired.y = minY;

      this.camera.position.copy(this.desired);
      this.camera.lookAt(this.target);
      this.camera.rotateY(shakeX);
      this.camera.rotateX(shakeY);
      this.camera.fov = damp(this.camera.fov, CHASE_FOV, 10, dt);
    }

    this.camera.updateProjectionMatrix();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
