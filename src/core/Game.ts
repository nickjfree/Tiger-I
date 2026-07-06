/* ---------------------------------------------------------------------------
 * Game: renderer, world, and the master loop.
 *
 * Boot → tank selection menu (battlefield idles behind it) → startMatch():
 * the player's tank spawns at the origin, the AI takes the other vehicle
 * ~380 m out. First tank destroyed loses.
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
import { TankSpec, SPECS } from '../tank/config';
import { TankAI } from '../ai/TankAI';
import { HUD } from '../ui/HUD';
import { Menu } from '../ui/Menu';
import { AudioManager } from '../audio/AudioManager';
import { clamp } from '../utils/math';

interface BurningWreck {
  tank: Tank;
  acc: number;
}

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
  private readonly hud: HUD;
  private readonly audio = new AudioManager();

  // match state
  private player: Tank | null = null;
  private enemy: Tank | null = null;
  private enemyAI: TankAI | null = null;
  private playerMarks: TrackMarks | null = null;
  private enemyMarks: TrackMarks | null = null;
  private matchOver = false;
  private readonly wrecks: BurningWreck[] = [];

  private idleAngle = 0;

  private readonly gunAimPoint = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpV3 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.input = new Input(this.renderer.domElement);
    this.input.onFirstInteraction = () => this.audio.start();
    this.rig = new CameraRig(window.innerWidth / window.innerHeight);

    this.terrain = new Terrain();
    this.scene.add(this.terrain.group);
    this.props = new Props(this.terrain);
    this.scene.add(this.props.group);
    this.ground = new Ground(this.terrain, this.props);
    this.env = new Environment(this.scene);
    this.targets = new Targets(this.terrain);
    this.scene.add(this.targets.group);

    this.particles = new Particles(this.scene);
    this.debris = new Debris(this.scene, this.ground);
    this.projectiles = new Projectiles(this.scene, this.ground, this.targets, this.props, this.particles);

    this.hud = new HUD(container, this.terrain);
    new Menu(container, (spec) => this.startMatch(spec));

    // --- world event wiring (match-independent) ---
    this.projectiles.onImpact = (pos, big) => {
      if (!big || !this.player) return;
      const dist = pos.distanceTo(this.player.position);
      this.audio.playImpact(dist);
      this.rig.addShake(clamp(18 / Math.max(6, dist), 0, 0.5));
    };
    this.projectiles.onPropHit = (kind, index, point, dir, shell) => {
      if (!shell) return;
      const dist = point.distanceTo(this.rig.camera.position);
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
    this.projectiles.onTankHit = (shooter, victim, result, point) => {
      // sound
      if (result.type === 'penetration') this.audio.playPenetration(point);
      else this.audio.playRicochet(point);

      // player feedback
      if (shooter === this.player) {
        this.hud.hitmarker(result.destroyed ? 'kill' : result.type);
      }
      if (victim === this.player) {
        this.hud.damageFlash();
        this.rig.addShake(result.type === 'penetration' ? 0.7 : 0.3);
      }
      if (result.destroyed) this.onTankKilled(victim);
    };
    this.targets.onDestroyed = (remaining) => {
      this.hud.showMessage(
        remaining > 0 ? `TARGET DESTROYED — ${remaining} REMAINING` : 'ALL TARGETS DESTROYED!',
      );
    };

    window.addEventListener('resize', () => this.onResize());

    (window as unknown as { __game: Game }).__game = this;
  }

  start(): void {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ------------------------------------------------------------------ */
  /* match lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  private startMatch(playerSpec: TankSpec): void {
    const enemySpec = playerSpec.id === 'tiger' ? SPECS.t34 : SPECS.tiger;

    // menu click counts as the first user gesture
    this.audio.start();
    this.audio.configurePlayerEngine(playerSpec.engineAudio);
    this.audio.configureEnemyEngine(enemySpec.engineAudio);

    this.player = new Tank(this.scene, this.ground, this.particles, this.projectiles, this.audio, playerSpec);
    this.enemy = new Tank(this.scene, this.ground, this.particles, this.projectiles, this.audio, enemySpec);
    this.projectiles.tanks.push(this.player, this.enemy);

    // spawn the enemy ~380 m out on a random bearing, facing the player
    const ang = Math.random() * Math.PI * 2;
    const ex = Math.sin(ang) * 380;
    const ez = Math.cos(ang) * 380;
    this.player.placeAt(0, 0, ang, this.ground); // face the threat axis
    this.enemy.placeAt(ex, ez, ang + Math.PI, this.ground);

    this.enemyAI = new TankAI(this.enemy, this.player, this.ground);
    this.playerMarks = new TrackMarks(this.scene, this.ground, playerSpec.trackWidth, playerSpec.trackLinkPitch);
    this.enemyMarks = new TrackMarks(this.scene, this.ground, enemySpec.trackWidth, enemySpec.trackLinkPitch);

    this.hud.setMatchInfo(
      playerSpec.id === 'tiger' ? 'MAYBACH HL230 P45' : 'V-2-34 DIESEL',
      playerSpec.gun.label,
      `${enemySpec.displayName.toUpperCase()}`,
      playerSpec.displayName,
    );
    this.hud.showMessage(`${enemySpec.displayName} reported in the area. Destroy it!`);
  }

  private onTankKilled(victim: Tank): void {
    // kill explosion + start burning
    this.particles.explosion(victim.position.clone().setY(victim.position.y + 1), this.tmpV.set(0, 1, 0));
    this.audio.playExplosion(victim.position);
    this.wrecks.push({ tank: victim, acc: 0 });
    this.rig.addShake(clamp(30 / Math.max(8, victim.position.distanceTo(this.rig.camera.position)), 0, 1));

    if (this.matchOver) return;
    this.matchOver = true;
    const playerWon = victim !== this.player;
    setTimeout(() => {
      this.hud.showBanner(
        playerWon ? 'SIEG!' : 'DEFEAT',
        playerWon
          ? `Enemy ${victim.spec.displayName} destroyed — press R for a new battle`
          : 'Your tank was knocked out — press R to try again',
        playerWon,
      );
    }, 1200);
  }

  /* ------------------------------------------------------------------ */
  /* frame                                                               */
  /* ------------------------------------------------------------------ */

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.input.wasPressed('KeyM')) this.audio.toggleMute();
    if (this.input.wasPressed('KeyH')) this.hud.toggleHelp();
    if (this.input.wasPressed('KeyR') && this.matchOver) window.location.reload();

    if (!this.player || !this.enemy) {
      this.idleFrame(dt);
      return;
    }
    const player = this.player;
    const enemy = this.enemy;

    if (this.input.wasPressed('KeyT') && !player.destroyed) player.physics.resetUpright();

    // --- camera & player control ---
    this.rig.update(dt, this.input, player, this.ground);
    this.audio.listener.copy(this.rig.camera.position);

    const playerAlive = !player.destroyed;
    player.update(
      dt,
      {
        throttle: playerAlive ? this.input.throttle : 0,
        steer: playerAlive ? this.input.steer : 0,
        brake: this.input.brake || !playerAlive,
      },
      this.rig.aimDir,
      {
        fireMain: playerAlive && this.input.firePrimary && this.input.pointerLocked,
        fireCoax: playerAlive && this.input.coaxHeld && this.input.pointerLocked,
        fireHullMG: playerAlive && this.input.hullMGHeld && this.input.pointerLocked,
      },
    );

    // --- enemy AI ---
    const cmd = this.enemyAI!.update(dt);
    enemy.update(dt, cmd.drive, cmd.aimDir, cmd.triggers);
    enemy.gun.silentReload = true;

    // --- interactions & marks for both tanks ---
    this.interactProps(player, true);
    this.interactProps(enemy, false);
    if (this.playerMarks) this.updateTrackMarks(player, this.playerMarks, dt);
    if (this.enemyMarks) this.updateTrackMarks(enemy, this.enemyMarks, dt);

    // --- world & effects ---
    this.props.update(dt);
    this.targets.update(dt);
    this.projectiles.update(dt);
    this.particles.update(dt);
    this.debris.update(dt);
    this.updateWrecks(dt);
    this.env.update(this.rig.camera.position, player.position);

    // --- audio ---
    this.audio.update(
      player.destroyed ? 0 : player.physics.engineLoad,
      (player.physics.trackSpeedLeft + player.physics.trackSpeedRight) / 2,
    );
    this.audio.updateEnemy(
      enemy.position.distanceTo(this.rig.camera.position),
      enemy.physics.engineLoad,
      !enemy.destroyed,
    );

    // --- HUD ---
    player.gun.getGunAimPoint(400, this.gunAimPoint);
    const hullYaw = Math.atan2(player.forward.x, player.forward.z);
    this.hud.update(
      dt,
      {
        speedKmh: player.physics.speedKmh,
        engineLoad: player.physics.engineLoad,
        ammo: player.gun.ammo,
        reloadProgress: player.gun.reloadProgress,
        tankPos: player.position,
        hullYaw,
        turretYaw: player.gun.turretYaw,
        gunAimPoint: this.gunAimPoint,
        sightMode: this.rig.sightMode,
        locked: this.input.pointerLocked,
        muted: this.audio.muted,
        targets: this.targets.getMarkers(),
        playerHp: player.hp,
        playerMaxHp: player.spec.hp,
        enemy: {
          x: enemy.position.x,
          z: enemy.position.z,
          alive: !enemy.destroyed,
          hp: enemy.hp,
          maxHp: enemy.spec.hp,
          name: enemy.spec.displayName,
        },
      },
      this.rig.camera,
    );

    this.renderer.render(this.scene, this.rig.camera);
  }

  /** Slow cinematic orbit while the selection menu is up. */
  private idleFrame(dt: number): void {
    this.idleAngle += dt * 0.05;
    const r = 42;
    const cx = Math.sin(this.idleAngle) * r;
    const cz = Math.cos(this.idleAngle) * r;
    const h = this.ground.getHeight(cx, cz);
    this.rig.camera.position.set(cx, h + 14, cz);
    this.rig.camera.lookAt(0, this.ground.getHeight(0, 0) + 2, 0);
    this.env.update(this.rig.camera.position, this.tmpV.set(0, 0, 0));
    this.particles.update(dt);
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** Continuous fire + smoke from destroyed tanks. */
  private updateWrecks(dt: number): void {
    for (const w of this.wrecks) {
      w.acc += dt * 22;
      while (w.acc >= 1) {
        w.acc -= 1;
        this.tmpV
          .set((Math.random() - 0.5) * 1.4, 1.6, (Math.random() - 0.5) * 2.2)
          .add(w.tank.position);
        // flame tongue
        this.particles.emit({
          pos: this.tmpV, posSpread: 0.3,
          vel: new THREE.Vector3(0, 2.6, 0), velSpread: 0.7,
          count: 1, life: [0.25, 0.6], size: [0.7, 1.3], sizeEnd: 0.5,
          color: 0xffb340, colorEnd: 0xff3d00, alpha: 0.85, additive: true, drag: 0.4,
        });
        // black smoke column
        this.particles.emit({
          pos: this.tmpV, posSpread: 0.4,
          vel: new THREE.Vector3(0, 2.2, 0), velSpread: 0.6,
          count: 1, life: [2.2, 4.5], size: [1.0, 1.8], sizeEnd: 4.5,
          color: 0x1c1a17, colorEnd: 0x3a3835, alpha: 0.5, drag: 0.6, gravity: -0.6,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */

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

  /** Hull vs standing props: tanks crush what they drive into. */
  private interactProps(tank: Tank, isPlayer: boolean): void {
    const pos = tank.position;
    const quat = tank.model.root.quaternion;
    this.tmpQ.copy(quat).invert();
    const body = tank.physics.body;
    const speed = Math.hypot(body.velocity.x, body.velocity.z);
    const camDist = this.rig.camera.position.distanceTo(pos);
    const hw = tank.spec.hitbox.halfW + 0.1;
    const hl = tank.spec.hitbox.halfL + 0.2;

    this.tmpV3.set(body.velocity.x, 0, body.velocity.z);
    if (this.tmpV3.lengthSq() < 0.25) this.tmpV3.copy(tank.forward).setY(0);
    this.tmpV3.normalize();

    for (const i of this.props.standingTreesNear(pos.x, pos.z)) {
      const t = this.props.trees[i];
      this.tmpV.set(t.x - pos.x, 0, t.z - pos.z).applyQuaternion(this.tmpQ);
      if (Math.abs(this.tmpV.x) < hw && Math.abs(this.tmpV.z) < hl) {
        this.props.fellTree(i, this.tmpV3.x, this.tmpV3.z);
        this.splinters(this.tmpV2.set(t.x, t.y + 0.6, t.z));
        this.audio.playWoodCrack(camDist);
        if (isPlayer) this.rig.addShake(0.12);
        body.velocity.x *= 0.96;
        body.velocity.z *= 0.96;
      }
    }

    for (const i of this.props.standingFencesNear(pos.x, pos.z)) {
      const f = this.props.fences[i];
      this.tmpV.set(f.x - pos.x, 0, f.z - pos.z).applyQuaternion(this.tmpQ);
      if (Math.abs(this.tmpV.x) < hw + 0.1 && Math.abs(this.tmpV.z) < hl + 0.1) {
        this.props.breakFence(i, this.tmpV3.x, this.tmpV3.z);
        this.splinters(this.tmpV2.set(f.x, f.y + 0.7, f.z));
        this.audio.playWoodCrack(camDist);
      }
    }

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
        if (isPlayer) this.rig.addShake(0.3);
        body.velocity.x *= 0.9;
        body.velocity.z *= 0.9;
      }
    }

    if (isPlayer) this.targets.crushBy(pos, quat);
  }

  private updateTrackMarks(tank: Tank, marks: TrackMarks, dt: number): void {
    const stations = tank.physics.stations;
    const n = tank.spec.wheelAxlesZ.length;
    let onL = false;
    let onR = false;
    for (let i = 0; i < n; i++) {
      if (stations[i].contact) onL = true;
      if (stations[n + i].contact) onR = true;
    }
    const quat = tank.model.root.quaternion;
    const centerL = this.tmpV.set(tank.spec.trackCenterX, 0, 0).applyQuaternion(quat).add(tank.position);
    const centerR = this.tmpV2.set(-tank.spec.trackCenterX, 0, 0).applyQuaternion(quat).add(tank.position);
    this.tmpV3.set(1, 0, 0).applyQuaternion(quat);
    this.tmpV3.y = 0;
    this.tmpV3.normalize();
    marks.update(dt, onL, centerL, onR, centerR, this.tmpV3);
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rig.resize(window.innerWidth / window.innerHeight);
  }
}
