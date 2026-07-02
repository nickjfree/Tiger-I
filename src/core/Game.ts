/* ---------------------------------------------------------------------------
 * Game: renderer, scene graph, and the master update loop that wires
 * terrain → physics → tank → effects → camera → HUD → audio together.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Input } from './Input';
import { CameraRig } from './CameraRig';
import { Terrain } from '../world/Terrain';
import { Environment } from '../world/Environment';
import { Targets } from '../world/Targets';
import { Particles } from '../effects/Particles';
import { Projectiles } from '../effects/Projectiles';
import { Tank } from '../tank/Tank';
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
  private readonly env: Environment;
  private readonly targets: Targets;
  private readonly particles: Particles;
  private readonly projectiles: Projectiles;
  private readonly tank: Tank;
  private readonly hud: HUD;
  private readonly audio = new AudioManager();

  private readonly gunAimPoint = new THREE.Vector3();

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
    this.env = new Environment(this.scene);
    this.targets = new Targets(this.terrain);
    this.scene.add(this.targets.group);

    // --- effects ---
    this.particles = new Particles(this.scene);
    this.projectiles = new Projectiles(this.scene, this.terrain, this.targets, this.particles);

    // --- the Tiger ---
    this.tank = new Tank(this.scene, this.terrain, this.particles, this.projectiles, this.audio);

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
    this.rig.update(dt, this.input, this.tank, this.terrain);

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

    // --- world & effects ---
    this.targets.update(dt);
    this.projectiles.update(dt);
    this.particles.update(dt);
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

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rig.resize(window.innerWidth / window.innerHeight);
  }
}
