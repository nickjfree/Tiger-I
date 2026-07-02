/* ---------------------------------------------------------------------------
 * Procedural Tiger I (late production) visual model.
 *
 * Built entirely from primitives at real-world proportions (see config.ts).
 * Hierarchy:
 *   root                         ← follows the physics body
 *   ├─ hull details, fenders, exhausts, tools
 *   ├─ wheels/sprockets/idlers   ← animated by Tank.ts (suspension + spin)
 *   └─ turretPivot (yaw)
 *      ├─ turret shell, cupola, bin
 *      └─ gunPivot (elevation)
 *         ├─ mantlet (+ coax MG port, gun sight)
 *         └─ recoilGroup → barrel sections → muzzle (Object3D)
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { TIGER } from './config';
import { TankMaterials } from './materials';

export class TigerModel {
  readonly root = new THREE.Group();
  readonly turretPivot = new THREE.Group();
  readonly gunPivot = new THREE.Group();
  readonly recoilGroup = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  readonly coaxMuzzle = new THREE.Object3D();
  readonly hullMGMuzzle = new THREE.Object3D();
  readonly exhausts: THREE.Object3D[] = [];

  /** Per-axle wheel groups (front→rear), for suspension/spin animation. */
  readonly wheelsLeft: THREE.Group[] = [];
  readonly wheelsRight: THREE.Group[] = [];
  readonly sprockets: THREE.Group[] = []; // [left, right]
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
  /* helpers                                                             */
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

  /** Cylinder with its axis along +Z (three's default is +Y). */
  private tube(r1: number, r2: number, len: number, mat: THREE.Material, seg = 20): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(r1, r2, len, seg);
    geo.rotateX(Math.PI / 2);
    return new THREE.Mesh(geo, mat);
  }

  /** Cylinder with its axis along +X (wheels). */
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

    // Lower hull tub (between the tracks)
    g.add(this.box(2.0, 0.73, 6.1, armor, 0, -0.365, 0));

    // Superstructure: full-width upper hull with sponsons over the tracks
    g.add(this.box(3.56, 0.63, 5.78, armor, 0, 0.315, -0.27));

    // Driver's plate (vertical front, 100 mm) — slightly proud & tilted 9°
    g.add(this.box(3.42, 0.66, 0.1, armor, 0, 0.32, 2.62, -0.16));

    // Glacis: shallow plate connecting driver plate to the nose
    g.add(this.box(3.42, 0.06, 0.6, armor, 0, -0.06, 2.9, 0.295));

    // Lower nose plate between the tracks (leans back slightly)
    g.add(this.box(2.1, 0.64, 0.12, armor, 0, -0.42, 3.08, 0.26));

    // Rear plate
    g.add(this.box(3.4, 1.2, 0.1, armor, 0, 0.0, -3.14));

    // ---- crew fittings, front ----
    // Driver's visor (left = +X) and hull MG ball mount (right)
    g.add(this.box(0.52, 0.16, 0.08, steel, 0.62, 0.42, 2.7, -0.16));
    const mgBall = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), armor);
    mgBall.position.set(-0.62, 0.34, 2.68);
    g.add(mgBall);
    const mgBarrel = this.tube(0.028, 0.028, 0.42, steel, 10);
    mgBarrel.position.set(-0.62, 0.34, 2.92);
    g.add(mgBarrel);
    this.hullMGMuzzle.position.set(-0.62, 0.34, 3.14);
    g.add(this.hullMGMuzzle);

    // Headlight (single central Bosch light, late pattern)
    const light = this.disc(0.09, 0.12, steel, 14);
    light.rotation.set(0, 0, 0);
    light.geometry = new THREE.CylinderGeometry(0.09, 0.09, 0.14, 14);
    light.position.set(0, 0.7, 2.72);
    g.add(light);

    // ---- roof details ----
    // Driver / radio operator hatches
    for (const x of [0.85, -0.85]) {
      const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 18), paint);
      hatch.position.set(x, 0.655, 2.2);
      g.add(hatch);
      g.add(this.box(0.1, 0.08, 0.1, dark, x, 0.68, 1.82)); // periscope
    }

    // ---- engine deck (rear) ----
    // Central engine access hatch
    const engHatch = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.05, 20), armor);
    engHatch.position.set(0, 0.655, -2.25);
    g.add(engHatch);
    // Radiator grilles with dark inset tops
    for (const x of [-1.05, 1.05]) {
      for (const z of [-1.75, -2.75]) {
        g.add(this.box(0.9, 0.07, 0.85, armor, x, 0.66, z));
        g.add(this.box(0.78, 0.02, 0.73, dark, x, 0.7, z));
      }
    }

    // ---- fenders / track guards ----
    for (const side of [1, -1]) {
      g.add(this.box(0.82, 0.03, 5.9, paint, side * 1.44, 0.02, -0.2));
      g.add(this.box(0.82, 0.03, 0.6, paint, side * 1.44, -0.05, 3.0, -0.18)); // front flap
      g.add(this.box(0.82, 0.03, 0.5, paint, side * 1.44, -0.03, -3.35, 0.15)); // rear flap
    }

    // ---- exhausts (two shrouded mufflers on the rear plate) ----
    for (const x of [-0.62, 0.62]) {
      const muffler = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.85, 14), steel);
      muffler.position.set(x, 0.5, -3.3);
      g.add(muffler);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.18, 10), dark);
      tip.position.set(x, 0.99, -3.3);
      g.add(tip);
      const exhaustPoint = new THREE.Object3D();
      exhaustPoint.position.set(x, 1.08, -3.3);
      g.add(exhaustPoint);
      this.exhausts.push(exhaustPoint);
    }

    // ---- pioneer tools & stowage ----
    // Tow cables along the sponson tops
    for (const side of [1, -1]) {
      const cable = this.tube(0.03, 0.03, 4.4, steel, 8);
      cable.position.set(side * 1.7, 0.58, -0.4);
      g.add(cable);
    }
    // Shovel + axe on the glacis area / side
    g.add(this.box(0.09, 0.03, 1.5, wood, 1.55, 0.66, 0.9));
    g.add(this.box(0.09, 0.03, 1.2, wood, -1.55, 0.66, -0.6));
    // Jack on the rear plate, low
    g.add(this.box(0.8, 0.18, 0.22, steel, 0, -0.45, -3.28));
    // Front tow shackle plates
    for (const x of [-0.85, 0.85]) {
      g.add(this.box(0.09, 0.26, 0.2, armor, x, -0.4, 3.2));
    }
  }

  /* ------------------------------------------------------------------ */
  /* running gear                                                        */
  /* ------------------------------------------------------------------ */

  /** One late-production steel-rimmed road wheel. */
  private makeRoadWheel(): THREE.Group {
    const { paint, steel, dark } = this.m;
    const w = new THREE.Group();
    const tire = this.disc(TIGER.wheelRadius, 0.08, steel, 26);
    const face = this.disc(TIGER.wheelRadius - 0.06, 0.1, paint, 26);
    const hub = this.disc(0.13, 0.14, paint, 14);
    const cap = this.disc(0.07, 0.16, dark, 10);
    w.add(tire, face, hub, cap);
    return w;
  }

  private buildRunningGear(): void {
    const { paint, steel } = this.m;

    for (const side of [1, -1] as const) {
      const xc = side * TIGER.trackCenterX;
      const wheels = side === 1 ? this.wheelsLeft : this.wheelsRight;

      // Interleaved pattern: odd axles carry twin discs, even axles a single
      TIGER.wheelAxlesZ.forEach((z, i) => {
        const axle = new THREE.Group();
        axle.position.set(xc, -0.8, z); // rest height; animated later
        if (i % 2 === 0) {
          const a = this.makeRoadWheel();
          a.position.x = side * 0.12;
          const b = this.makeRoadWheel();
          b.position.x = side * -0.12;
          axle.add(a, b);
        } else {
          axle.add(this.makeRoadWheel());
        }
        this.root.add(axle);
        wheels.push(axle);
      });

      // Drive sprocket (front) — twin toothed rings
      const sprocket = new THREE.Group();
      sprocket.position.set(xc, TIGER.sprocket.y, TIGER.sprocket.z);
      for (const off of [0.1, -0.1]) {
        const ring = this.disc(TIGER.sprocket.r, 0.05, paint, 22);
        ring.position.x = off;
        sprocket.add(ring);
      }
      const sprocketHub = this.disc(0.24, 0.24, paint, 16);
      sprocket.add(sprocketHub);
      for (let t = 0; t < 12; t++) {
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.06), steel);
        const a = (t / 12) * Math.PI * 2;
        tooth.position.set(0, Math.sin(a) * (TIGER.sprocket.r - 0.01), Math.cos(a) * (TIGER.sprocket.r - 0.01));
        tooth.rotation.x = -a;
        sprocket.add(tooth);
      }
      this.root.add(sprocket);
      this.sprockets.push(sprocket);

      // Idler (rear)
      const idler = new THREE.Group();
      idler.position.set(xc, TIGER.idler.y, TIGER.idler.z);
      const idlerRing = this.disc(TIGER.idler.r, 0.09, paint, 20);
      const idlerHub = this.disc(0.12, 0.14, paint, 12);
      idler.add(idlerRing, idlerHub);
      this.root.add(idler);
      this.idlers.push(idler);
    }
  }

  /* ------------------------------------------------------------------ */
  /* turret & armament                                                   */
  /* ------------------------------------------------------------------ */

  private buildTurret(): void {
    const { armor, paint, steel, dark } = this.m;

    this.turretPivot.position.set(0, TIGER.hullTopY, TIGER.turretRingZ);
    this.root.add(this.turretPivot);

    // --- horseshoe turret shell (flat front, curved sides/rear) ---
    // Shape is drawn in plan view; shape-Y maps to world −Z after rotation.
    const plan = new THREE.Shape();
    plan.moveTo(-0.88, -0.95);
    plan.lineTo(0.88, -0.95);
    plan.lineTo(0.92, 0.1);
    plan.absarc(0, 0.1, 0.92, 0, Math.PI, false);
    plan.lineTo(-0.88, -0.95);

    const shellGeo = new THREE.ExtrudeGeometry(plan, {
      depth: 0.72,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.025,
      bevelSegments: 1,
      curveSegments: 24,
    });
    shellGeo.rotateX(-Math.PI / 2); // extrusion now along +Y, plan −Y → +Z
    const shell = new THREE.Mesh(shellGeo, armor);
    shell.position.y = 0.0;
    this.turretPivot.add(shell);

    // Turret ring collar under the shell
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.12, 28), armor);
    collar.position.y = -0.05;
    this.turretPivot.add(collar);

    // --- commander's cupola (late cast pattern, left rear) ---
    const cupola = new THREE.Group();
    cupola.position.set(0.45, 0.75, -0.4);
    const cupolaBody = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.38, 0.26, 20), armor);
    cupola.add(cupolaBody);
    const cupolaHatch = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 18), paint);
    cupolaHatch.position.y = 0.15;
    cupola.add(cupolaHatch);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const scope = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.05), dark);
      scope.position.set(Math.sin(a) * 0.3, 0.02, Math.cos(a) * 0.3);
      scope.rotation.y = a;
      cupola.add(scope);
    }
    this.turretPivot.add(cupola);

    // Loader's hatch (right roof)
    const loaderHatch = this.box(0.46, 0.05, 0.46, paint, -0.48, 0.74, -0.32);
    this.turretPivot.add(loaderHatch);

    // Roof ventilator dome
    const vent = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), armor);
    vent.position.set(0, 0.72, 0.25);
    this.turretPivot.add(vent);

    // Rear stowage bin (Rommelkiste)
    this.turretPivot.add(this.box(1.35, 0.42, 0.42, paint, 0, 0.32, -1.24));

    // Spare track links on the turret sides (late-war field practice)
    for (const side of [1, -1]) {
      for (const z of [0.25, -0.18]) {
        this.turretPivot.add(this.box(0.07, 0.42, 0.38, steel, side * 0.94, 0.28, z));
      }
    }

    // --- gun pivot (trunnions) ---
    this.gunPivot.position.set(0, 0.36, 0.9);
    this.turretPivot.add(this.gunPivot);

    // Cast mantlet (fixed to the trunnions, elevates with the gun)
    const mantlet = this.box(1.64, 0.78, 0.24, armor, 0, 0, 0.1);
    this.gunPivot.add(mantlet);
    // Gunner's TZF sight aperture (left of the gun) & coax MG port (right)
    const sightTube = this.tube(0.035, 0.035, 0.3, dark, 10);
    sightTube.position.set(0.36, 0.2, 0.16);
    this.gunPivot.add(sightTube);
    const coaxTube = this.tube(0.03, 0.03, 0.34, steel, 10);
    coaxTube.position.set(-0.46, 0.06, 0.2);
    this.gunPivot.add(coaxTube);
    this.coaxMuzzle.position.set(-0.46, 0.06, 0.4);
    this.gunPivot.add(this.coaxMuzzle);

    // --- 8.8 cm KwK 36 L/56 (recoiling parts) ---
    this.gunPivot.add(this.recoilGroup);
    const sections: Array<[number, number, number, number]> = [
      // [radius near, radius far, length, z-center]
      [0.1, 0.095, 0.95, 0.7], // recoil sleeve
      [0.075, 0.07, 1.9, 2.1], // mid tube
      [0.062, 0.058, 1.7, 3.9], // outer tube
    ];
    for (const [r1, r2, len, zc] of sections) {
      const seg = this.tube(r2, r1, len, paint, 18);
      seg.position.z = zc;
      this.recoilGroup.add(seg);
    }
    // Double-baffle muzzle brake
    for (const [len, zc] of [
      [0.18, 4.86],
      [0.16, 5.08],
    ] as Array<[number, number]>) {
      const baffle = this.tube(0.115, 0.115, len, paint, 16);
      baffle.position.z = zc;
      this.recoilGroup.add(baffle);
    }
    const brakeCore = this.tube(0.06, 0.06, 0.34, paint, 12);
    brakeCore.position.z = 4.95;
    this.recoilGroup.add(brakeCore);

    this.muzzle.position.set(0, 0, 5.18);
    this.recoilGroup.add(this.muzzle);
  }
}
