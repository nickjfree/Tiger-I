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

/** Structural interface every tank model must satisfy (Tiger, T-34, …). */
export interface TankModelLike {
  root: THREE.Group;
  turretPivot: THREE.Group;
  gunPivot: THREE.Group;
  recoilGroup: THREE.Group;
  muzzle: THREE.Object3D;
  coaxMuzzle: THREE.Object3D;
  hullMGMuzzle: THREE.Object3D;
  exhausts: THREE.Object3D[];
  wheelsLeft: THREE.Group[];
  wheelsRight: THREE.Group[];
  sprockets: THREE.Group[];
  idlers: THREE.Group[];
}

export class TigerModel implements TankModelLike {
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
    g.add(this.box(0.6, 0.06, 0.06, armor, 0.62, 0.53, 2.69, -0.16)); // visor rain hood
    const mgCollar = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 10, 20), armor);
    mgCollar.position.set(-0.62, 0.34, 2.66);
    g.add(mgCollar);
    const mgBall = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), armor);
    mgBall.position.set(-0.62, 0.34, 2.68);
    g.add(mgBall);
    const mgBarrel = this.tube(0.028, 0.028, 0.42, steel, 10);
    mgBarrel.position.set(-0.62, 0.34, 2.92);
    g.add(mgBarrel);
    this.hullMGMuzzle.position.set(-0.62, 0.34, 3.14);
    g.add(this.hullMGMuzzle);

    // Spare track links racked on the lower nose plate (common field fit)
    for (let i = 0; i < 4; i++) {
      g.add(this.box(0.4, 0.36, 0.06, steel, -0.68 + i * 0.45, -0.35, 3.2, 0.26));
    }

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
    // Radiator grilles: raised frames with actual slat bars over a dark well
    for (const x of [-1.05, 1.05]) {
      for (const z of [-1.75, -2.75]) {
        g.add(this.box(0.9, 0.07, 0.85, armor, x, 0.66, z));
        g.add(this.box(0.78, 0.02, 0.73, dark, x, 0.675, z));
        for (let s = 0; s < 8; s++) {
          g.add(this.box(0.78, 0.018, 0.045, steel, x, 0.7, z - 0.33 + s * 0.094));
        }
      }
    }

    // ---- fenders / track guards ----
    for (const side of [1, -1]) {
      g.add(this.box(0.82, 0.03, 5.9, paint, side * 1.44, 0.02, -0.2));
      g.add(this.box(0.82, 0.03, 0.6, paint, side * 1.44, -0.05, 3.0, -0.18)); // front flap
      g.add(this.box(0.82, 0.03, 0.5, paint, side * 1.44, -0.03, -3.35, 0.15)); // rear flap
    }

    // ---- exhausts (two shrouded mufflers on the rear plate) ----
    const shieldMat = armor.clone();
    shieldMat.side = THREE.DoubleSide;
    for (const x of [-0.62, 0.62]) {
      const muffler = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.85, 14), steel);
      muffler.position.set(x, 0.5, -3.3);
      g.add(muffler);
      // sheet-metal heat shield wrapped around the rear half
      const shield = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.9, 14, 1, true, Math.PI * 0.65, Math.PI * 0.7),
        shieldMat,
      );
      shield.position.set(x, 0.52, -3.3);
      g.add(shield);
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

    // --- horseshoe turret shell -----------------------------------------
    // Historical basis: the side wall is a single 82 mm band, circular at
    // the rear and flat at the front; the ball race under it is Ø 2100 mm,
    // giving an external width of ~2.16 m. Front plate ~100 mm at 5°.
    // Shape is drawn in plan view; shape-Y maps to world −Z after rotation.
    const plan = new THREE.Shape();
    plan.moveTo(-0.95, -0.98);
    plan.lineTo(0.95, -0.98);
    plan.lineTo(1.08, -0.02);
    plan.absarc(0, -0.02, 1.08, 0, Math.PI, false);
    plan.lineTo(-0.95, -0.98);

    const shellGeo = new THREE.ExtrudeGeometry(plan, {
      depth: 0.78,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.025,
      bevelSegments: 1,
      curveSegments: 28,
    });
    shellGeo.rotateX(-Math.PI / 2); // extrusion now along +Y, plan −Y → +Z
    const shell = new THREE.Mesh(shellGeo, armor);
    this.turretPivot.add(shell);

    // Turret ring collar (ball race Ø ≈ 2.1 m)
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.12, 32), armor);
    collar.position.y = -0.05;
    this.turretPivot.add(collar);

    // --- commander's cupola (late cast pattern, left rear) ---
    const cupola = new THREE.Group();
    cupola.position.set(0.55, 0.82, -0.45);
    const cupolaBody = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.4, 0.28, 22), armor);
    cupola.add(cupolaBody);
    const cupolaHatch = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.05, 18), paint);
    cupolaHatch.position.y = 0.16;
    cupola.add(cupolaHatch);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const scope = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.05), dark);
      scope.position.set(Math.sin(a) * 0.31, 0.0, Math.cos(a) * 0.31);
      scope.rotation.y = a;
      cupola.add(scope);
    }
    this.turretPivot.add(cupola);

    // Loader's hatch (right roof)
    this.turretPivot.add(this.box(0.48, 0.05, 0.48, paint, -0.55, 0.8, -0.35));

    // Roof ventilator dome + pistol-port plug on the right wall
    const vent = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), armor);
    vent.position.set(0, 0.78, 0.3);
    this.turretPivot.add(vent);

    // Escape/loading hatch disc on the rear-right wall
    {
      const px = -0.92;
      const pz = -0.6;
      const phi = Math.atan2(px, pz + 0.02); // radial direction
      const hatch = this.disc(0.27, 0.06, armor, 20);
      hatch.position.set(px, 0.4, pz);
      hatch.rotation.y = phi - Math.PI / 2;
      this.turretPivot.add(hatch);
    }

    // Rear stowage bin (Rommelkiste) hugging the turret rear arc
    this.turretPivot.add(this.box(1.7, 0.46, 0.45, paint, 0, 0.34, -1.33));
    this.turretPivot.add(this.box(1.7, 0.05, 0.5, paint, 0, 0.6, -1.33));

    // Spare track links on the turret sides (late-war field practice)
    for (const side of [1, -1]) {
      for (const z of [0.35, -0.1]) {
        this.turretPivot.add(this.box(0.07, 0.44, 0.4, steel, side * 1.06, 0.3, z));
      }
    }

    // --- gun pivot (trunnions) ---
    this.gunPivot.position.set(0, 0.37, 0.88);
    this.turretPivot.add(this.gunPivot);

    // Mantlet block + production-pattern cylindrical gun sleeve
    const mantlet = this.box(1.86, 0.8, 0.22, armor, 0, 0, 0.06);
    this.gunPivot.add(mantlet);
    const sleeve = this.tube(0.13, 0.175, 0.5, armor, 22);
    sleeve.position.set(0, 0, 0.38);
    this.gunPivot.add(sleeve);

    // Gunner's TZF sight aperture (left of the gun) & coax MG port (right)
    const sightTube = this.tube(0.035, 0.035, 0.3, dark, 10);
    sightTube.position.set(0.4, 0.22, 0.12);
    this.gunPivot.add(sightTube);
    const coaxTube = this.tube(0.03, 0.03, 0.36, steel, 10);
    coaxTube.position.set(-0.52, 0.06, 0.16);
    this.gunPivot.add(coaxTube);
    this.coaxMuzzle.position.set(-0.52, 0.06, 0.36);
    this.gunPivot.add(this.coaxMuzzle);

    // --- 8.8 cm KwK 36 L/56 (recoiling parts) --------------------------
    // Sized so overall vehicle length ≈ 8.45 m (hull 6.32 m + overhang).
    this.gunPivot.add(this.recoilGroup);
    const sections: Array<[number, number, number, number]> = [
      // [radius near(breech side), radius far, length, z-center]
      [0.115, 0.105, 0.95, 0.68], // outer recoil sleeve
      [0.1, 0.075, 1.45, 1.88], // tapering mid section
      [0.072, 0.062, 1.58, 3.39], // outer tube
    ];
    for (const [r1, r2, len, zc] of sections) {
      const seg = this.tube(r2, r1, len, paint, 20);
      seg.position.z = zc;
      this.recoilGroup.add(seg);
    }
    // Bulbous double-baffle muzzle brake (Ø ~29 cm)
    const brakeCore = this.tube(0.068, 0.068, 0.5, paint, 14);
    brakeCore.position.z = 4.4;
    this.recoilGroup.add(brakeCore);
    for (const [len, zc] of [
      [0.2, 4.31],
      [0.18, 4.56],
    ] as Array<[number, number]>) {
      const baffle = this.tube(0.145, 0.145, len, paint, 18);
      baffle.position.z = zc;
      this.recoilGroup.add(baffle);
    }

    this.muzzle.position.set(0, 0, 4.68);
    this.recoilGroup.add(this.muzzle);
  }
}
