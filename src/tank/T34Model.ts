/* ---------------------------------------------------------------------------
 * Procedural T-34-85 (model 1944) visual model.
 *
 * Built from primitives at real proportions (see config.ts T34 spec):
 *   · iconic sloped hull — 45 mm glacis at 60°, sides leaning ~40°
 *   · big three-man cast turret set forward, commander's cupola on the left
 *   · 85 mm ZiS-S-53 with cast mantlet and NO muzzle brake (plain tube)
 *   · 5 large Ø830 mm Christie road wheels/side, front idler, REAR drive
 *     sprocket with roller teeth
 *   · external fuel drums, grab rails for tank riders, fender stowage
 *
 * Same hierarchy contract as TigerModel (TankModelLike).
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { T34 } from './config';
import { TankMaterials } from './materials';
import { TankModelLike } from './TigerModel';

export class T34Model implements TankModelLike {
  readonly root = new THREE.Group();
  readonly turretPivot = new THREE.Group();
  readonly gunPivot = new THREE.Group();
  readonly recoilGroup = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  readonly coaxMuzzle = new THREE.Object3D();
  readonly hullMGMuzzle = new THREE.Object3D();
  readonly exhausts: THREE.Object3D[] = [];

  readonly wheelsLeft: THREE.Group[] = [];
  readonly wheelsRight: THREE.Group[] = [];
  readonly sprockets: THREE.Group[] = [];
  readonly idlers: THREE.Group[] = [];

  constructor(private readonly m: TankMaterials) {
    this.buildHull();
    this.buildRunningGear();
    this.buildTurret();
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /* ------------------------------------------------------------------ */

  private box(
    w: number, h: number, d: number, mat: THREE.Material,
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    return mesh;
  }

  private tube(r1: number, r2: number, len: number, mat: THREE.Material, seg = 20): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(r1, r2, len, seg);
    geo.rotateX(Math.PI / 2);
    return new THREE.Mesh(geo, mat);
  }

  private disc(r: number, w: number, mat: THREE.Material, seg = 24): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(r, r, w, seg);
    geo.rotateZ(Math.PI / 2);
    return new THREE.Mesh(geo, mat);
  }

  /* ------------------------------------------------------------------ */
  /* hull                                                                */
  /* ------------------------------------------------------------------ */

  private buildHull(): void {
    const { armor, paint, steel, dark, wood } = this.m;
    const g = this.root;

    // Lower hull tub between the tracks
    g.add(this.box(1.9, 0.75, 6.0, armor, 0, -0.375, 0));

    // Upper hull core (roof plane at +0.40) — sloped plates dress its flanks
    g.add(this.box(2.2, 0.5, 5.0, armor, 0, 0.15, -0.45));

    // Roof plate
    g.add(this.box(2.24, 0.05, 5.1, armor, 0, 0.4, -0.45));

    // --- the famous 60° glacis: bow tip at (y −0.10, z 3.05) up to roof front ---
    // plate direction: dy 0.52, dz −1.0 → length ≈ 1.13
    g.add(this.box(2.96, 0.06, 1.16, armor, 0, 0.15, 2.55, Math.atan2(-0.52, -1.0)));

    // Lower bow plate (reverse slope from the tip down to the tub)
    // runs (Δy −0.65, Δz −0.6) → rx = atan2(+0.65, −0.6)
    g.add(this.box(2.3, 0.06, 0.9, armor, 0, -0.42, 2.76, Math.atan2(0.65, -0.6)));

    // Sloped upper side plates (~40°) leaning over the tracks
    for (const side of [1, -1]) {
      g.add(this.box(0.05, 0.64, 5.1, armor, side * 1.32, 0.13, -0.45, 0, 0, side * 0.42));
    }

    // Rear plate, sloped ~47°
    g.add(this.box(2.5, 0.06, 0.95, armor, 0, -0.15, -3.02, -1.05));
    // Round transmission hatch on the rear slope
    const rHatch = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 18), armor);
    rHatch.position.set(0, -0.12, -3.06);
    rHatch.rotation.x = -1.05; // axis ⊥ to the sloped rear plate
    g.add(rHatch);

    // --- fenders over the tracks ---
    for (const side of [1, -1]) {
      g.add(this.box(0.56, 0.03, 6.4, paint, side * 1.24, -0.03, 0.1));
      g.add(this.box(0.56, 0.03, 0.55, paint, side * 1.24, -0.13, 3.25, -0.35)); // bow flap
    }

    // --- glacis fittings ---
    // Driver's hatch (left) with two periscopes
    g.add(this.box(0.6, 0.05, 0.5, armor, 0.48, 0.245, 2.42, Math.atan2(-0.52, -1.0)));
    g.add(this.box(0.09, 0.1, 0.09, dark, 0.36, 0.44, 2.1));
    g.add(this.box(0.09, 0.1, 0.09, dark, 0.6, 0.44, 2.1));
    // Hull MG ball mount (right side of glacis)
    const mgBall = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), armor);
    mgBall.position.set(-0.55, 0.12, 2.62);
    g.add(mgBall);
    const mgBarrel = this.tube(0.026, 0.026, 0.36, steel, 10);
    mgBarrel.position.set(-0.55, 0.19, 2.79);
    mgBarrel.rotation.x = -0.45;
    g.add(mgBarrel);
    this.hullMGMuzzle.position.set(-0.55, 0.26, 2.96);
    g.add(this.hullMGMuzzle);
    // Headlight + horn (left of driver)
    const light = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 12), steel);
    light.rotation.x = Math.PI / 2 - 0.5;
    light.position.set(0.95, 0.32, 2.35);
    g.add(light);
    // Tow hooks on the bow sides
    for (const x of [-1.05, 1.05]) {
      g.add(this.box(0.1, 0.16, 0.18, steel, x, -0.2, 2.88));
    }
    // Spare track links on the glacis (right side)
    for (let i = 0; i < 3; i++) {
      g.add(this.box(0.5, 0.05, 0.2, steel, -0.6 + i * 0.02, 0.02 + i * 0.0, 2.72 - i * 0.22, Math.atan2(-0.52, -1.0)));
    }

    // --- engine deck (rear) ---
    // Central rectangular grille with slats
    g.add(this.box(1.1, 0.04, 1.5, armor, 0, 0.43, -1.7));
    for (let s = 0; s < 9; s++) {
      g.add(this.box(1.0, 0.018, 0.06, steel, 0, 0.455, -1.05 - s * 0.16));
    }
    // Round engine access hatch forward of the grille
    const engHatch = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 18), armor);
    engHatch.position.set(0, 0.435, -0.55);
    g.add(engHatch);

    // --- exhausts: two armored outlets on the rear plate ---
    for (const x of [-0.55, 0.55]) {
      g.add(this.box(0.28, 0.34, 0.14, steel, x, 0.06, -3.12, -1.05));
      const exhaustPoint = new THREE.Object3D();
      exhaustPoint.position.set(x, 0.14, -3.2);
      g.add(exhaustPoint);
      this.exhausts.push(exhaustPoint);
    }

    // --- external cylindrical fuel drums on the sloped rear sides ---
    for (const side of [1, -1]) {
      for (const z of [-1.35, -2.35]) {
        const drum = this.tube(0.185, 0.185, 0.8, steel, 16);
        drum.position.set(side * 1.42, 0.16, z);
        g.add(drum);
      }
    }

    // --- grab rails (for tank riders) along the upper hull sides ---
    for (const side of [1, -1]) {
      for (const z of [1.2, -0.2]) {
        const rail = this.tube(0.018, 0.018, 0.85, steel, 8);
        rail.position.set(side * 1.24, 0.28, z);
        g.add(rail);
      }
    }

    // Fender stowage boxes + saw
    g.add(this.box(0.5, 0.16, 0.9, paint, 1.24, 0.06, 1.9));
    g.add(this.box(0.5, 0.16, 0.7, paint, -1.24, 0.06, -2.5));
    g.add(this.box(0.08, 0.03, 1.1, wood, -1.24, 0.0, 1.6));
  }

  /* ------------------------------------------------------------------ */
  /* running gear — Christie: 5 big wheels, front idler, rear sprocket   */
  /* ------------------------------------------------------------------ */

  private makeRoadWheel(): THREE.Group {
    const { paint, dark } = this.m;
    const w = new THREE.Group();
    const tire = this.disc(T34.wheelRadius, 0.1, dark, 26); // rubber tire
    const face = this.disc(T34.wheelRadius - 0.075, 0.12, paint, 26);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(T34.wheelRadius - 0.07, 0.018, 8, 24), paint);
    rim.rotation.y = Math.PI / 2;
    rim.position.x = 0.065;
    const hub = this.disc(0.1, 0.15, paint, 14);
    w.add(tire, face, rim, hub);
    return w;
  }

  private buildRunningGear(): void {
    const { paint, steel } = this.m;

    for (const side of [1, -1] as const) {
      const xc = side * T34.trackCenterX;
      const wheels = side === 1 ? this.wheelsLeft : this.wheelsRight;
      const restY = T34.hardpointY - T34.suspensionRest + 0.12;

      for (const z of T34.wheelAxlesZ) {
        const axle = new THREE.Group();
        axle.position.set(xc, restY, z);
        axle.add(this.makeRoadWheel());
        this.root.add(axle);
        wheels.push(axle);
      }

      // REAR drive sprocket with 6 roller teeth (T-34 signature)
      const sprocket = new THREE.Group();
      sprocket.position.set(xc, T34.sprocket.y, T34.sprocket.z);
      for (const off of [0.07, -0.07]) {
        const ring = this.disc(T34.sprocket.r, 0.045, paint, 20);
        ring.position.x = off;
        sprocket.add(ring);
      }
      for (let t = 0; t < 6; t++) {
        const a = (t / 6) * Math.PI * 2;
        const roller = this.disc(0.05, 0.16, steel, 10);
        roller.position.set(0, Math.sin(a) * 0.21, Math.cos(a) * 0.21);
        sprocket.add(roller);
      }
      const hub = this.disc(0.11, 0.18, paint, 12);
      sprocket.add(hub);
      this.root.add(sprocket);
      this.sprockets.push(sprocket);

      // Front idler
      const idler = new THREE.Group();
      idler.position.set(xc, T34.idler.y, T34.idler.z);
      idler.add(this.disc(T34.idler.r, 0.09, paint, 20), this.disc(0.09, 0.12, paint, 12));
      this.root.add(idler);
      this.idlers.push(idler);
    }
  }

  /* ------------------------------------------------------------------ */
  /* turret & armament                                                   */
  /* ------------------------------------------------------------------ */

  private buildTurret(): void {
    const { armor, paint, steel, dark } = this.m;

    this.turretPivot.position.set(0, T34.hullTopY, T34.turretRingZ);
    this.root.add(this.turretPivot);

    // --- large cast turret: egg-shaped plan, sloped cast walls via bevel ---
    // Shape-Y maps to world −Z after rotation (front at negative shape-Y).
    const plan = new THREE.Shape();
    plan.moveTo(-0.52, -1.05);
    plan.quadraticCurveTo(-1.0, -0.72, -1.02, 0.05);
    plan.quadraticCurveTo(-1.0, 0.78, -0.45, 1.02);
    plan.quadraticCurveTo(0, 1.18, 0.45, 1.02);
    plan.quadraticCurveTo(1.0, 0.78, 1.02, 0.05);
    plan.quadraticCurveTo(1.0, -0.72, 0.52, -1.05);
    plan.quadraticCurveTo(0, -1.22, -0.52, -1.05);

    const shellGeo = new THREE.ExtrudeGeometry(plan, {
      depth: 0.44,
      bevelEnabled: true,
      bevelThickness: 0.16, // fat bevel ⇒ sloped cast sides
      bevelSize: 0.14,
      bevelSegments: 2,
      curveSegments: 20,
    });
    shellGeo.rotateX(-Math.PI / 2);
    const shell = new THREE.Mesh(shellGeo, armor);
    shell.position.y = 0.16;
    this.turretPivot.add(shell);

    // Turret ring collar (Ø ≈ 1.6 m)
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.12, 26), armor);
    collar.position.y = 0.02;
    this.turretPivot.add(collar);

    // --- commander's cupola (left rear) ---
    const cupola = new THREE.Group();
    cupola.position.set(0.5, 0.72, -0.35);
    cupola.add(new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.31, 0.24, 18), armor));
    const cupolaHatch = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.05, 16), paint);
    cupolaHatch.position.y = 0.14;
    cupola.add(cupolaHatch);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const scope = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.04), dark);
      scope.position.set(Math.sin(a) * 0.24, 0.0, Math.cos(a) * 0.24);
      scope.rotation.y = a;
      cupola.add(scope);
    }
    this.turretPivot.add(cupola);

    // Loader's hatch (right roof)
    this.turretPivot.add(this.box(0.42, 0.05, 0.42, paint, -0.45, 0.66, -0.2));

    // Twin mushroom ventilator domes on the rear roof (T-34-85 signature)
    for (const x of [-0.16, 0.16]) {
      const vent = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        armor,
      );
      vent.position.set(x, 0.62, -0.72);
      this.turretPivot.add(vent);
    }

    // Turret grab rails
    for (const side of [1, -1]) {
      const rail = this.tube(0.018, 0.018, 0.7, steel, 8);
      rail.position.set(side * 1.02, 0.35, -0.1);
      this.turretPivot.add(rail);
    }

    // --- gun pivot ---
    this.gunPivot.position.set(0, 0.3, 0.5);
    this.turretPivot.add(this.gunPivot);

    // Cast mantlet: rounded block + cheeks
    const mantlet = this.box(0.66, 0.5, 0.2, armor, 0, 0, 0.55);
    this.gunPivot.add(mantlet);
    const mantletRound = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.6, 16));
    mantletRound.material = armor;
    mantletRound.geometry.rotateZ(Math.PI / 2);
    mantletRound.position.set(0, 0, 0.5);
    this.gunPivot.add(mantletRound);
    // gun collar
    const collar2 = this.tube(0.105, 0.13, 0.4, armor, 16);
    collar2.position.z = 0.78;
    this.gunPivot.add(collar2);

    // Gunner's sight (left) & coax MG (right)
    const sightTube = this.tube(0.03, 0.03, 0.24, dark, 10);
    sightTube.position.set(0.3, 0.16, 0.58);
    this.gunPivot.add(sightTube);
    const coaxTube = this.tube(0.026, 0.026, 0.3, steel, 10);
    coaxTube.position.set(-0.33, 0.02, 0.62);
    this.gunPivot.add(coaxTube);
    this.coaxMuzzle.position.set(-0.33, 0.02, 0.8);
    this.gunPivot.add(this.coaxMuzzle);

    // --- 85 mm ZiS-S-53 L/54.6: clean tapered tube, no muzzle brake ---
    this.gunPivot.add(this.recoilGroup);
    const sections: Array<[number, number, number, number]> = [
      [0.095, 0.085, 0.9, 1.35], // breech-end sleeve
      [0.082, 0.062, 1.5, 2.55], // taper
      [0.06, 0.05, 1.15, 3.85], // outer tube to the plain muzzle
    ];
    for (const [r1, r2, len, zc] of sections) {
      const seg = this.tube(r2, r1, len, paint, 18);
      seg.position.z = zc;
      this.recoilGroup.add(seg);
    }

    this.muzzle.position.set(0, 0, 4.44);
    this.recoilGroup.add(this.muzzle);
  }
}
