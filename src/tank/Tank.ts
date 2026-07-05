/* ---------------------------------------------------------------------------
 * Tank facade: owns physics + model + tracks + gun and keeps them in sync.
 *
 * Per frame:
 *   1. step physics (suspension, drive, steering)
 *   2. copy body transform onto the visual root
 *   3. animate road wheels (suspension travel + spin), sprockets, idlers
 *   4. rebuild/scroll the track links from the live wheel heights
 *   5. update fire control
 *   6. emit exhaust smoke and track dust
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TIGER } from './config';
import { TankPhysics, DriveInput } from './TankPhysics';
import { TigerModel } from './TigerModel';
import { Tracks } from './Tracks';
import { Gun, GunTriggers } from './Gun';
import { createTankMaterials } from './materials';
import { GroundLike } from '../world/Ground';
import { Particles } from '../effects/Particles';
import { Projectiles } from '../effects/Projectiles';
import { AudioManager } from '../audio/AudioManager';
import { clamp } from '../utils/math';

export class Tank {
  readonly physics: TankPhysics;
  readonly model: TigerModel;
  readonly tracks: Tracks;
  readonly gun: Gun;

  readonly position = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);

  private distLeft = 0;
  private distRight = 0;
  private exhaustAcc = 0;
  private readonly wheelYLeft: number[] = [];
  private readonly wheelYRight: number[] = [];

  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly terrain: GroundLike,
    private readonly particles: Particles,
    projectiles: Projectiles,
    audio: AudioManager,
  ) {
    const materials = createTankMaterials();
    this.physics = new TankPhysics(terrain);
    this.model = new TigerModel(materials);
    this.tracks = new Tracks(this.model.root, materials.track);
    this.gun = new Gun(this.model, this.physics, projectiles, particles, audio);
    scene.add(this.model.root);
  }

  update(dt: number, drive: DriveInput, aimDir: THREE.Vector3, triggers: GunTriggers): void {
    // 1. physics
    this.physics.update(dt, drive);

    // 2. sync visual root with the body
    const b = this.physics.body;
    this.model.root.position.set(b.position.x, b.position.y, b.position.z);
    this.model.root.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    this.position.copy(this.model.root.position);
    this.forward.set(0, 0, 1).applyQuaternion(this.model.root.quaternion);

    // 3. running gear animation
    this.distLeft += this.physics.trackSpeedLeft * dt;
    this.distRight += this.physics.trackSpeedRight * dt;

    const stations = this.physics.stations;
    const nWheels = TIGER.wheelAxlesZ.length;
    this.wheelYLeft.length = 0;
    this.wheelYRight.length = 0;
    for (let i = 0; i < nWheels; i++) {
      // stations were created left side first, same front→rear order
      const compL = stations[i].visualCompression;
      const compR = stations[nWheels + i].visualCompression;
      // wheel center = hardpoint − (rest − compression)
      this.wheelYLeft.push(TIGER.hardpointY - TIGER.suspensionRest + compL);
      this.wheelYRight.push(TIGER.hardpointY - TIGER.suspensionRest + compR);
    }

    // rolling constraint: contact point stationary => spin = +distance/r
    const spinL = this.distLeft / TIGER.wheelRadius;
    const spinR = this.distRight / TIGER.wheelRadius;
    for (let i = 0; i < nWheels; i++) {
      const wl = this.model.wheelsLeft[i];
      const wr = this.model.wheelsRight[i];
      wl.position.y = this.wheelYLeft[i];
      wr.position.y = this.wheelYRight[i];
      wl.rotation.x = spinL;
      wr.rotation.x = spinR;
    }
    const sprocketR = TIGER.sprocket.r + TIGER.trackThickness / 2;
    const idlerR = TIGER.idler.r + TIGER.trackThickness / 2;
    this.model.sprockets[0].rotation.x = this.distLeft / sprocketR;
    this.model.sprockets[1].rotation.x = this.distRight / sprocketR;
    this.model.idlers[0].rotation.x = this.distLeft / idlerR;
    this.model.idlers[1].rotation.x = this.distRight / idlerR;

    // 4. tracks conform to the animated wheels and scroll with ground speed
    this.tracks.update(
      dt,
      this.physics.trackSpeedLeft,
      this.physics.trackSpeedRight,
      this.wheelYLeft,
      this.wheelYRight,
    );

    // 5. fire control
    this.gun.update(dt, aimDir, triggers);

    // 6. effects
    this.emitExhaust(dt);
    this.emitDust();
  }

  private emitExhaust(dt: number): void {
    const load = this.physics.engineLoad;
    this.exhaustAcc += dt * (5 + load * 20);
    while (this.exhaustAcc >= 1) {
      this.exhaustAcc -= 1;
      for (const pipe of this.model.exhausts) {
        pipe.getWorldPosition(this.tmp);
        this.particles.exhaustPuff(this.tmp, load);
      }
    }
  }

  private emitDust(): void {
    for (const side of [1, -1] as const) {
      const speed = side === 1 ? this.physics.trackSpeedLeft : this.physics.trackSpeedRight;
      const target = side === 1 ? this.physics.targetSpeedLeft : this.physics.targetSpeedRight;
      const slip = Math.abs(target - speed);
      const intensity = clamp((Math.abs(speed) - 0.5) * 0.12 + slip * 0.35, 0, 1.3);
      if (intensity < 0.06) continue;

      // any wheel touching the ground on this side?
      const base = side === 1 ? 0 : TIGER.wheelAxlesZ.length;
      let contact = false;
      for (let i = 0; i < TIGER.wheelAxlesZ.length; i++) {
        if (this.physics.stations[base + i].contact) {
          contact = true;
          break;
        }
      }
      if (!contact) continue;

      // dust boils off the trailing end of the contact patch
      const rearZ = speed >= 0 ? -2.5 : 2.5;
      this.tmp
        .set(side * TIGER.trackCenterX, -1.05, rearZ)
        .applyQuaternion(this.model.root.quaternion)
        .add(this.model.root.position);
      this.tmpB.copy(this.forward).multiplyScalar(-Math.sign(speed) || -1);
      this.particles.trackDust(this.tmp, this.tmpB, intensity);
    }
  }
}
