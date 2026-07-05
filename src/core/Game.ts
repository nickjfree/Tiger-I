/* ---------------------------------------------------------------------------
 * Game: renderer, scene graph, and the master update loop that wires
 * terrain → physics → tank → effects → camera → HUD → audio together.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Input } from './Input';
import { CameraRig } from './CameraRig';
import { Terrain } from '../world/Terrain';
import { Props } from '../world/Props';
import { Ground } from '../world/Ground';
import { Environment } from '../world/Environment';
import { Targets } from '../world/Targets';
import { Particles } from '../effects/Particles';
import { Projectiles } from '../effects/Projectiles';
import { Debris } from '../effects/Debris';
import { TrackMarks } from '../effects/TrackMarks';
import { Tank } from '../tank/Tank';
import { TIGER } from '../tank/config';
import { HUD } from '../ui/HUD';
import { AudioManager } from '../audio/AudioManager';
import { clamp } from '../utils/math';

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly clock = new THREE.Clock();

  private readonly input: Input;
  private readonly rig: CameraRig;
  private readonly terrain: Terrain;
  private readonly props: Props;
  private readonly ground: Ground;
  private readonly env: Environment;
  private readonly targets: Targets;
  private readonly particles: Particles;
  private readonly projectiles: Projectiles;
  private readonly debris: Debris;
  private readonly marks: TrackMarks;
  private readonly tank: Tank;
  private readonly hud: HUD;
  private readonly audio = new AudioManager();

  private readonly gunAimPoint = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpV3 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  constructor(container: HTMLElement) {
    // --- renderer ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    // --- input & camera ---
    this.input = new Input(this.renderer.domElement);
    this.input.onFirstInteraction = () => this.audio.start();
    this.rig = new CameraRig(window.innerWidth / window.innerHeight);

    // --- world ---
    this.terrain = new Terrain();
    this.scene.add(this.terrain.group);
    this.props = new Props(this.terrain);
    this.scene.add(this.props.group);
    this.ground = new Ground(this.terrain, this.props);
    this.env = new Environment(this.scene);
    this.targets = new Targets(this.terrain);
    this.scene.add(this.targets.group);

    // --- effects ---
    this.particles = new Particles(this.scene);
    this.debris = new Debris(this.scene, this.ground);
    this.marks = new TrackMarks(this.scene, this.ground);
    this.projectiles = new Projectiles(this.scene, this.ground, this.targets, this.props, this.particles);

    // --- the Tiger ---
    this.tank = new Tank(this.scene, this.ground, this.particles, this.projectiles, this.audio);

    // --- HUD ---
    this.hud = new HUD(container, this.terrain);

    // --- event wiring ---
    this.tank.gun.onFired = () => this.rig.addShake(0.55);
    this.projectiles.onImpact = (pos, big) => {
      if (!big) return;
      const dist = pos.distanceTo(this.tank.position);
      this.audio.playImpact(dist);
      this.rig.addShake(clamp(18 / Math.max(6, dist), 0, 0.5));
    };
    this.projectiles.onPropHit = (kind, index, point, dir, shell) => {
      const dist = point.distanceTo(this.tank.position);
      if (!shell) return; // MG rounds just puff (handled inside Projectiles)
      if (kind === 'tree') {
        this.props.fellTree(index, dir.x, dir.z);
        this.splinters(point);
        this.audio.playWoodCrack(dist);
      } else if (kind === 'fence') {
        this.props.breakFence(index, dir.x, dir.z);
        this.splinters(point);
        this.audio.playWoodCrack(dist);
      } else {
        for (const piece of this.props.shatterShed(index, point, 26)) {
          this.debris.add(piece.mesh, piece.vel);
        }
        this.splinters(point);
        this.audio.playCrash(dist);
      }
    };
    this.targets.onDestroyed = (remaining) => {
      this.hud.showMessage(
        remaining > 0 ? `TARGET DESTROYED — ${remaining} REMAINING` : 'ALL TARGETS DESTROYED!',
      );
    };

    window.addEventListener('resize', () => this.onResize());
    this.hud.showMessage('PANZER VOR! Destroy the practice targets.');

    // handy for debugging / experimentation from the browser console
    (window as unknown as { __game: Game }).__game = this;
  }

  start(): void {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    // --- one-shot keys ---
    if (this.input.wasPressed('KeyT')) this.tank.physics.resetUpright();
    if (this.input.wasPressed('KeyM')) this.audio.toggleMute();
    if (this.input.wasPressed('KeyH')) this.hud.toggleHelp();

    // --- camera first: its view direction drives the turret ---
    this.rig.update(dt, this.input, this.tank, this.ground);

    // --- tank (physics, model sync, tracks, gun, dust/exhaust) ---
    this.tank.update(
      dt,
      { throttle: this.input.throttle, steer: this.input.steer, brake: this.input.brake },
      this.rig.aimDir,
      {
        fireMain: this.input.firePrimary && this.input.pointerLocked,
        fireCoax: this.input.coaxHeld && this.input.pointerLocked,
        fireHullMG: this.input.hullMGHeld && this.input.pointerLocked,
      },
    );

    // --- tank ↔ world interactions (crush trees/fences/sheds/targets) ---
    this.interactProps();
    this.updateTrackMarks(dt);

    // --- world & effects ---
    this.props.update(dt);
    this.targets.update(dt);
    this.projectiles.update(dt);
    this.particles.update(dt);
    this.debris.update(dt);
    this.env.update(this.rig.camera.position, this.tank.position);

    // --- audio follows the drivetrain ---
    this.audio.update(
      this.tank.physics.engineLoad,
      (this.tank.physics.trackSpeedLeft + this.tank.physics.trackSpeedRight) / 2,
    );

    // --- HUD ---
    this.tank.gun.getGunAimPoint(400, this.gunAimPoint);
    const hullYaw = Math.atan2(this.tank.forward.x, this.tank.forward.z);
    this.hud.update(
      dt,
      {
        speedKmh: this.tank.physics.speedKmh,
        engineLoad: this.tank.physics.engineLoad,
        ammo: this.tank.gun.ammo,
        reloadProgress: this.tank.gun.reloadProgress,
        tankPos: this.tank.position,
        hullYaw,
        turretYaw: this.tank.gun.turretYaw,
        gunAimPoint: this.gunAimPoint,
        sightMode: this.rig.sightMode,
        locked: this.input.pointerLocked,
        muted: this.audio.muted,
        targets: this.targets.getMarkers(),
      },
      this.rig.camera,
    );

    this.renderer.render(this.scene, this.rig.camera);
  }

  /** Small burst of wood splinters + dust at a break point. */
  private splinters(at: THREE.Vector3): void {
    this.particles.emit({
      pos: at,
      vel: new THREE.Vector3(0, 3.2, 0),
      velSpread: 3.4,
      count: 14,
      life: [0.3, 0.9],
      size: [0.08, 0.22],
      sizeEnd: 1.2,
      color: 0x8a6f47,
      colorEnd: 0x5c4a30,
      alpha: 0.9,
      gravity: 11,
      drag: 0.6,
    });
    this.particles.emit({
      pos: at,
      vel: new THREE.Vector3(0, 1.4, 0),
      velSpread: 1.2,
      count: 6,
      life: [0.6, 1.3],
      size: [0.4, 0.7],
      sizeEnd: 3,
      color: 0xa4906c,
      colorEnd: 0x6f6450,
      alpha: 0.3,
      drag: 1.5,
    });
  }

  /** Hull vs standing props: the Tiger crushes what it drives into. */
  private interactProps(): void {
    const pos = this.tank.position;
    const quat = this.tank.model.root.quaternion;
    this.tmpQ.copy(quat).invert();
    const body = this.tank.physics.body;
    const speed = Math.hypot(body.velocity.x, body.velocity.z);
    const camDist = this.rig.camera.position.distanceTo(pos);

    // movement direction for fall/debris (fallback: hull forward)
    this.tmpV3.set(body.velocity.x, 0, body.velocity.z);
    if (this.tmpV3.lengthSq() < 0.25) this.tmpV3.copy(this.tank.forward).setY(0);
    this.tmpV3.normalize();

    // trees
    for (const i of this.props.standingTreesNear(pos.x, pos.z)) {
      const t = this.props.trees[i];
      this.tmpV.set(t.x - pos.x, 0, t.z - pos.z).applyQuaternion(this.tmpQ);
      if (Math.abs(this.tmpV.x) < 1.95 && Math.abs(this.tmpV.z) < 3.4) {
        this.props.fellTree(i, this.tmpV3.x, this.tmpV3.z);
        this.splinters(this.tmpV2.set(t.x, t.y + 0.6, t.z));
        this.audio.playWoodCrack(camDist);
        this.rig.addShake(0.12);
        // pushing a tree over costs a little momentum
        body.velocity.x *= 0.96;
        body.velocity.z *= 0.96;
      }
    }

    // fences
    for (const i of this.props.standingFencesNear(pos.x, pos.z)) {
      const f = this.props.fences[i];
      this.tmpV.set(f.x - pos.x, 0, f.z - pos.z).applyQuaternion(this.tmpQ);
      if (Math.abs(this.tmpV.x) < 2.0 && Math.abs(this.tmpV.z) < 3.5) {
        this.props.breakFence(i, this.tmpV3.x, this.tmpV3.z);
        this.splinters(this.tmpV2.set(f.x, f.y + 0.7, f.z));
        this.audio.playWoodCrack(camDist);
      }
    }

    // sheds: the hull smashes straight through
    for (let i = 0; i < this.props.sheds.length; i++) {
      const sh = this.props.sheds[i];
      if (!sh.intact || speed < 0.4) continue;
      const d = Math.hypot(sh.x - pos.x, sh.z - pos.z);
      if (d < sh.radius + 1.7) {
        this.tmpV2.set(sh.x, sh.y + 1, sh.z);
        for (const piece of this.props.shatterShed(i, this.tmpV2.clone().addScaledVector(this.tmpV3, -1.5), 9 + speed * 2)) {
          this.debris.add(piece.mesh, piece.vel);
        }
        this.splinters(this.tmpV2);
        this.audio.playCrash(camDist);
        this.rig.addShake(0.3);
        body.velocity.x *= 0.9;
        body.velocity.z *= 0.9;
      }
    }

    // practice targets tip over when run down
    this.targets.crushBy(pos, quat);
  }

  private updateTrackMarks(dt: number): void {
    const stations = this.tank.physics.stations;
    const n = TIGER.wheelAxlesZ.length;
    let onL = false;
    let onR = false;
    for (let i = 0; i < n; i++) {
      if (stations[i].contact) onL = true;
      if (stations[n + i].contact) onR = true;
    }
    const quat = this.tank.model.root.quaternion;
    const centerL = this.tmpV.set(TIGER.trackCenterX, 0, 0).applyQuaternion(quat).add(this.tank.position);
    const centerR = this.tmpV2.set(-TIGER.trackCenterX, 0, 0).applyQuaternion(quat).add(this.tank.position);
    this.tmpV3.set(1, 0, 0).applyQuaternion(quat);
    this.tmpV3.y = 0;
    this.tmpV3.normalize();
    this.marks.update(dt, onL, centerL, onR, centerR, this.tmpV3);
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rig.resize(window.innerWidth / window.innerHeight);
  }
}
