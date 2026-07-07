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
import { HUD, ScoreRow } from '../ui/HUD';
import { Menu, MenuChoice } from '../ui/Menu';
import { NetClient } from '../net/NetClient';
import { RemoteTank } from '../net/RemoteTank';
import {
  ServerMsg, RosterEntry, PropEvent, TankId,
  PROTOCOL_VERSION, MAX_PLAYERS, CLIENT_STATE_HZ, INTERP_DELAY_MS, vec3, quat,
} from '../net/protocol';
import { AudioManager } from '../audio/AudioManager';
import { clamp } from '../utils/math';

interface BurningWreck {
  tank: { position: THREE.Vector3 };
  acc: number;
  id?: string; // net id, so a respawn can stop the fire
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

  // multiplayer state
  private netMode = false;
  private net: NetClient | null = null;
  private netId = '';
  private readonly remotes = new Map<string, RemoteTank>();
  private readonly remoteMarks = new Map<string, TrackMarks>();
  private readonly names = new Map<string, string>();
  private readonly scoreRows = new Map<string, { name: string; tank: string; kills: number; deaths: number; ai: boolean; alive: boolean }>();
  private respawnAtLocal = 0;
  private stateAcc = 0;
  private menu!: Menu;

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
    this.menu = new Menu(container, (choice: MenuChoice) => {
      if (choice.mode === 'sp') this.startMatch(choice.spec);
      else this.startNetMatch(choice.spec, choice.name);
    });

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
      this.sendProp(kind, index, dir.x, dir.z);
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

    // spawn the enemy ~380 m out on a random bearing, facing the player —
    // rejecting spots on steep slopes, rocks or sheds
    let ang = Math.random() * Math.PI * 2;
    let ex = Math.sin(ang) * 380;
    let ez = Math.cos(ang) * 380;
    for (let tries = 0; tries < 24; tries++) {
      const a = Math.random() * Math.PI * 2;
      const x = Math.sin(a) * 380;
      const z = Math.cos(a) * 380;
      const flat = this.ground.getNormal(x, z).y > 0.94;
      const onRock = this.props.rockBumpAt(x, z) > this.terrain.getHeight(x, z) + 0.05;
      const nearShed = this.props.sheds.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + 6);
      if (flat && !onRock && !nearShed) {
        ang = a;
        ex = x;
        ez = z;
        break;
      }
    }
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

    if (this.netMode) {
      if (this.player) this.netFrame(dt);
      else this.idleFrame(dt);
      return;
    }
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
    this.separateTanks(player, enemy);
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

  /**
   * Tank-vs-tank collision: a firm horizontal push-apart between the hulls
   * (approximated as circles). Prevents phasing through each other and makes
   * ramming shove the lighter vehicle.
   */
  private separateTanks(a: Tank, b: Tank): void {
    const ra = (a.spec.hitbox.halfW + a.spec.hitbox.halfL) * 0.52;
    const rb = (b.spec.hitbox.halfW + b.spec.hitbox.halfL) * 0.52;
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const d = Math.hypot(dx, dz);
    const overlap = ra + rb - d;
    if (overlap <= 0 || d < 1e-4) return;

    const nx = dx / d;
    const nz = dz / d;
    const ba = a.physics.body;
    const bb = b.physics.body;

    // stiff spring push applied at the centers (adds no torque). The force
    // only survives one physics substep (cannon clears it), so it is sized
    // accordingly; the velocity correction below does the hard stop.
    const push = overlap * 2e6;
    ba.force.x -= nx * push;
    ba.force.z -= nz * push;
    bb.force.x += nx * push;
    bb.force.z += nz * push;

    // kill closing velocity along the contact normal (inelastic bump)
    const rel = (bb.velocity.x - ba.velocity.x) * nx + (bb.velocity.z - ba.velocity.z) * nz;
    if (rel < 0) {
      const mSum = ba.mass + bb.mass;
      const j = (-rel * 0.9 * (ba.mass * bb.mass)) / mSum;
      ba.velocity.x -= (j / ba.mass) * nx;
      ba.velocity.z -= (j / ba.mass) * nz;
      bb.velocity.x += (j / bb.mass) * nx;
      bb.velocity.z += (j / bb.mass) * nz;
      if (Math.abs(rel) > 3) {
        this.audio.playCrash(this.rig.camera.position.distanceTo(a.position));
        this.rig.addShake(0.3);
      }
    }
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
        if (isPlayer) this.sendProp('tree', i, this.tmpV3.x, this.tmpV3.z);
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
        if (isPlayer) this.sendProp('fence', i, this.tmpV3.x, this.tmpV3.z);
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
        if (isPlayer) this.sendProp('shed', i, this.tmpV3.x, this.tmpV3.z);
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


  /* ------------------------------------------------------------------ */
  /* multiplayer                                                         */
  /* ------------------------------------------------------------------ */

  private startNetMatch(spec: TankSpec, name: string): void {
    this.audio.start();
    this.audio.configurePlayerEngine(spec.engineAudio);
    this.audio.configureEnemyEngine((spec.id === 'tiger' ? SPECS.t34 : SPECS.tiger).engineAudio);

    this.netMode = true;
    this.player = new Tank(this.scene, this.ground, this.particles, this.projectiles, this.audio, spec);
    this.projectiles.tanks.push(this.player);
    this.playerMarks = new TrackMarks(this.scene, this.ground, spec.trackWidth, spec.trackLinkPitch);

    this.hud.setMatchInfo(
      spec.id === 'tiger' ? 'MAYBACH HL230 P45' : 'V-2-34 DIESEL',
      spec.gun.label,
      'FEIND',
      spec.displayName,
    );
    this.hud.setOnlineCount('CONNECTING…');

    // network hooks
    this.projectiles.onShellFired = (pos, dir, speed, shooter) => {
      if (shooter === this.player) {
        this.net?.send({ t: 'fire', p: vec3(pos), d: vec3(dir), mv: speed });
      }
    };
    this.projectiles.onNetHit = (targetId, facet, dist, point) => {
      this.net?.send({ t: 'claim', target: targetId, facet, dist: Math.round(dist), point: vec3(point) });
    };

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.net = new NetClient();
    this.net.onMessage = (msg) => this.handleNet(msg);
    this.net.onClose = () => {
      if (!this.matchOver) {
        this.hud.showBanner('CONNECTION LOST', 'press R to return to the menu', false);
        this.matchOver = true;
      }
    };
    this.net.connect(url);
    // greet once the socket opens (NetClient buffers nothing — poll until open)
    const hello = setInterval(() => {
      if (this.net?.connected) {
        this.net.send({ t: 'hello', v: PROTOCOL_VERSION, name, tank: spec.id });
        clearInterval(hello);
      }
    }, 100);
  }

  private sendProp(kind: 'tree' | 'fence' | 'shed', index: number, dx: number, dz: number): void {
    if (this.netMode) this.net?.send({ t: 'prop', kind, index, dx: +dx.toFixed(3), dz: +dz.toFixed(3) });
  }

  private addRemote(entry: RosterEntry): void {
    const existing = this.remotes.get(entry.id);
    if (existing) {
      existing.dispose(this.scene);
      this.remotes.delete(entry.id);
    }
    const r = new RemoteTank(this.scene, entry.id, entry.name, entry.tank, this.particles, entry.ai);
    r.hp = entry.hp;
    r.push(0, entry.state);
    if (!entry.alive) r.setDestroyed(true);
    this.remotes.set(entry.id, r);
    this.projectiles.tanks.push(r);
    if (!this.remoteMarks.has(entry.id)) {
      this.remoteMarks.set(
        entry.id,
        new TrackMarks(this.scene, this.ground, r.spec.trackWidth, r.spec.trackLinkPitch),
      );
    }
    this.names.set(entry.id, entry.name);
    this.scoreRows.set(entry.id, {
      name: entry.name,
      tank: r.spec.displayName,
      kills: entry.kills,
      deaths: entry.deaths,
      ai: entry.ai,
      alive: entry.alive,
    });
  }

  private removeRemote(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.dispose(this.scene);
    this.remotes.delete(id);
    const idx = this.projectiles.tanks.indexOf(r);
    if (idx >= 0) this.projectiles.tanks.splice(idx, 1);
    this.scoreRows.delete(id);
  }

  private handleNet(msg: ServerMsg): void {
    switch (msg.t) {
      case 'full':
        this.hud.showBanner('ROOM FULL', '8 commanders already in battle — press R to retry', false);
        this.matchOver = true;
        break;

      case 'welcome': {
        this.netId = msg.id;
        this.names.set(msg.id, 'You');
        this.player!.placeAt(msg.spawn.x, msg.spawn.z, msg.spawn.yaw, this.ground);
        this.scoreRows.set(msg.id, {
          name: 'You',
          tank: this.player!.spec.displayName,
          kills: 0,
          deaths: 0,
          ai: false,
          alive: true,
        });
        for (const entry of msg.roster) {
          if (entry.id === msg.id) continue;
          this.addRemote(entry);
        }
        for (const ev of msg.props) this.applyRemoteProp(ev, true);
        this.hud.showMessage('You have joined the battle. Gute Jagd!');
        break;
      }

      case 'join':
        if (msg.entry.id !== this.netId) {
          this.addRemote(msg.entry);
          if (!msg.entry.ai) this.hud.addKillFeed(`${msg.entry.name} joined the battle`);
        }
        break;

      case 'leave':
        this.removeRemote(msg.id);
        this.hud.addKillFeed(`${msg.name} left`);
        break;

      case 'snap':
        for (const st of msg.s) {
          if (st.id === this.netId) continue;
          this.remotes.get(st.id)?.push(msg.time, st);
        }
        break;

      case 'fire': {
        if (msg.id === this.netId) break;
        this.tmpV.set(msg.p[0], msg.p[1], msg.p[2]);
        this.tmpV2.set(msg.d[0], msg.d[1], msg.d[2]);
        this.projectiles.fireShellVisual(this.tmpV, this.tmpV2, msg.mv);
        const r = this.remotes.get(msg.id);
        this.audio.playCannon(r ? r.spec.gun.sound : 'kwk36', this.tmpV);
        this.tmpV3.copy(this.tmpV2);
        this.particles.muzzleBlast(this.tmpV, this.tmpV3);
        break;
      }

      case 'hit': {
        this.tmpV.set(msg.point[0], msg.point[1], msg.point[2]);
        if (msg.pen) this.audio.playPenetration(this.tmpV);
        else this.audio.playRicochet(this.tmpV);
        if (msg.pen) this.particles.explosion(this.tmpV, this.tmpV2.set(0, 1, 0));

        if (msg.by === this.netId) {
          this.hud.hitmarker(msg.killed ? 'kill' : msg.pen ? 'penetration' : 'ricochet');
        }

        if (msg.target === this.netId) {
          const p = this.player!;
          p.hp = msg.hp;
          if (msg.pen) {
            this.hud.damageFlash();
            this.rig.addShake(0.7);
          } else {
            this.rig.addShake(0.3);
          }
          if (msg.killed && !p.destroyed) {
            p.destroy();
            this.audio.playExplosion(p.position);
            this.wrecks.push({ tank: p, acc: 0, id: this.netId });
            this.respawnAtLocal = performance.now() + 5000;
          }
        } else {
          const r = this.remotes.get(msg.target);
          if (r) {
            r.hp = msg.hp;
            if (msg.killed && r.alive) {
              r.setDestroyed(true);
              this.audio.playExplosion(r.position);
              this.particles.explosion(this.tmpV2.copy(r.position).setY(r.position.y + 1), this.tmpV3.set(0, 1, 0));
              this.wrecks.push({ tank: r, acc: 0, id: msg.target });
              const row = this.scoreRows.get(msg.target);
              if (row) row.alive = false;
            }
          }
        }
        break;
      }

      case 'spawn': {
        // stop the old wreck burning
        for (let i = this.wrecks.length - 1; i >= 0; i--) {
          if (this.wrecks[i].id === msg.id) this.wrecks.splice(i, 1);
        }
        if (msg.id === this.netId) {
          const p = this.player!;
          p.revive();
          p.placeAt(msg.x, msg.z, msg.yaw, this.ground);
          this.hud.showRespawn(null);
          this.hud.showMessage('Back in the fight!');
        } else {
          const r = this.remotes.get(msg.id);
          if (r) {
            r.setDestroyed(false);
            r.hp = msg.hp;
            const row = this.scoreRows.get(msg.id);
            if (row) row.alive = true;
          }
        }
        break;
      }

      case 'kill': {
        const by = msg.by === this.netId ? 'You' : msg.byName;
        const victim = msg.victim === this.netId ? 'You' : msg.victimName;
        this.hud.addKillFeed(`${by}  ⚔  ${victim}`);
        break;
      }

      case 'scores':
        for (const sc of msg.s) {
          const row = this.scoreRows.get(sc.id);
          if (row) {
            row.kills = sc.kills;
            row.deaths = sc.deaths;
          }
        }
        break;

      case 'prop':
        this.applyRemoteProp(msg, false);
        break;
    }
  }

  private applyRemoteProp(ev: PropEvent, silent: boolean): void {
    if (ev.kind === 'tree') {
      const t = this.props.trees[ev.index];
      if (!t || t.state !== 0) return;
      this.props.fellTree(ev.index, ev.dx, ev.dz);
      if (silent) {
        // late-join catch-up: skip straight to "down"
        t.fallT = 1;
      } else {
        this.audio.playWoodCrack(this.rig.camera.position.distanceTo(this.tmpV.set(t.x, t.y, t.z)));
      }
    } else if (ev.kind === 'fence') {
      const f = this.props.fences[ev.index];
      if (!f || f.state !== 0) return;
      this.props.breakFence(ev.index, ev.dx, ev.dz);
      if (silent) f.fallT = 1;
    } else {
      const sh = this.props.sheds[ev.index];
      if (!sh || !sh.intact) return;
      this.tmpV.set(sh.x, sh.y + 1, sh.z);
      if (silent) {
        // no debris fireworks for history — just remove the building
        for (const piece of this.props.shatterShed(ev.index, this.tmpV, 0.1)) {
          piece.mesh.removeFromParent();
        }
      } else {
        for (const piece of this.props.shatterShed(ev.index, this.tmpV, 16)) {
          this.debris.add(piece.mesh, piece.vel);
        }
        this.audio.playCrash(this.rig.camera.position.distanceTo(this.tmpV));
      }
    }
  }

  /** One-sided separation: only the local body can be pushed. */
  private separateFromGhost(player: Tank, ghost: RemoteTank): void {
    const ra = (player.spec.hitbox.halfW + player.spec.hitbox.halfL) * 0.52;
    const rb = (ghost.spec.hitbox.halfW + ghost.spec.hitbox.halfL) * 0.52;
    const dx = player.position.x - ghost.position.x;
    const dz = player.position.z - ghost.position.z;
    const d = Math.hypot(dx, dz);
    const overlap = ra + rb - d;
    if (overlap <= 0 || d < 1e-4) return;
    const b = player.physics.body;
    const nx = dx / d;
    const nz = dz / d;
    b.force.x += nx * overlap * 2e6;
    b.force.z += nz * overlap * 2e6;
    const closing = b.velocity.x * -nx + b.velocity.z * -nz;
    if (closing > 0) {
      b.velocity.x += nx * closing * 0.9;
      b.velocity.z += nz * closing * 0.9;
      if (closing > 3) {
        this.audio.playCrash(this.rig.camera.position.distanceTo(player.position));
        this.rig.addShake(0.3);
      }
    }
  }

  private netFrame(dt: number): void {
    const player = this.player!;
    const net = this.net!;

    if (this.input.wasPressed('KeyT') && !player.destroyed) player.physics.resetUpright();

    this.rig.update(dt, this.input, player, this.ground);
    this.audio.listener.copy(this.rig.camera.position);

    const alive = !player.destroyed;
    const coax = alive && this.input.coaxHeld && this.input.pointerLocked;
    const hullMG = alive && this.input.hullMGHeld && this.input.pointerLocked;
    player.update(
      dt,
      {
        throttle: alive ? this.input.throttle : 0,
        steer: alive ? this.input.steer : 0,
        brake: this.input.brake || !alive,
      },
      this.rig.aimDir,
      {
        fireMain: alive && this.input.firePrimary && this.input.pointerLocked,
        fireCoax: coax,
        fireHullMG: hullMG,
      },
    );

    // stream our state
    this.stateAcc += dt;
    if (this.stateAcc >= 1 / CLIENT_STATE_HZ && net.connected) {
      this.stateAcc = 0;
      const b = player.physics.body;
      net.send({
        t: 'st',
        p: vec3(b.position),
        q: quat(b.quaternion),
        ty: +player.gun.turretYaw.toFixed(3),
        gp: +player.gun.gunPitch.toFixed(3),
        vl: +player.physics.trackSpeedLeft.toFixed(2),
        vr: +player.physics.trackSpeedRight.toFixed(2),
        mg: (coax ? 1 : 0) | (hullMG ? 2 : 0),
      });
    }

    // remote ghosts: interpolate in the past
    const renderTime = net.serverNow() - INTERP_DELAY_MS;
    let nearest: RemoteTank | null = null;
    let nearestD = Infinity;
    for (const r of this.remotes.values()) {
      r.update(dt, renderTime, this.rig.camera.position);
      if (!player.destroyed && r.alive) this.separateFromGhost(player, r);
      const marks = this.remoteMarks.get(r.netId);
      if (marks) this.updateGhostMarks(r, marks, dt);
      const d = r.position.distanceTo(this.rig.camera.position);
      if (r.alive && d < nearestD) {
        nearestD = d;
        nearest = r;
      }
    }

    this.interactProps(player, true);
    if (this.playerMarks) this.updateTrackMarks(player, this.playerMarks, dt);

    this.props.update(dt);
    this.targets.update(dt);
    this.projectiles.update(dt);
    this.particles.update(dt);
    this.debris.update(dt);
    this.updateWrecks(dt);
    this.env.update(this.rig.camera.position, player.position);

    this.audio.update(
      player.destroyed ? 0 : player.physics.engineLoad,
      (player.physics.trackSpeedLeft + player.physics.trackSpeedRight) / 2,
    );
    this.audio.updateEnemy(
      nearest ? nearestD : 9999,
      nearest ? clamp(Math.max(Math.abs(nearest.speedL), Math.abs(nearest.speedR)) / 8, 0.15, 1) : 0,
      !!nearest,
    );

    // respawn countdown
    if (player.destroyed && this.respawnAtLocal > 0) {
      this.hud.showRespawn((this.respawnAtLocal - performance.now()) / 1000);
    }

    // scoreboard on Tab
    const tabDown = this.input.isDown('Tab');
    this.hud.setScoreboardVisible(tabDown);
    if (tabDown) {
      const rows: ScoreRow[] = [];
      for (const [id, r] of this.scoreRows) {
        rows.push({ ...r, me: id === this.netId });
      }
      rows.sort((a, b) => b.kills - a.kills);
      this.hud.setScoreboard(rows);
    }

    let humans = 0;
    for (const r of this.scoreRows.values()) if (!r.ai) humans++;
    this.hud.setOnlineCount(
      net.connected ? `${humans}/${MAX_PLAYERS} ONLINE · ${net.rttMs.toFixed(0)} ms` : 'RECONNECTING…',
    );

    // HUD
    player.gun.getGunAimPoint(400, this.gunAimPoint);
    const hullYaw = Math.atan2(player.forward.x, player.forward.z);
    const remoteMarkers: Array<{ x: number; z: number; alive: boolean }> = [];
    for (const r of this.remotes.values()) {
      remoteMarkers.push({ x: r.position.x, z: r.position.z, alive: r.alive });
    }
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
        enemy: null,
        remotes: remoteMarkers,
      },
      this.rig.camera,
    );

    this.renderer.render(this.scene, this.rig.camera);
  }

  private updateGhostMarks(ghost: RemoteTank, marks: TrackMarks, dt: number): void {
    const moving = Math.max(Math.abs(ghost.speedL), Math.abs(ghost.speedR)) > 0.15;
    const on = ghost.alive && moving;
    const quatG = ghost.model.root.quaternion;
    const centerL = this.tmpV.set(ghost.spec.trackCenterX, 0, 0).applyQuaternion(quatG).add(ghost.position);
    const centerR = this.tmpV2.set(-ghost.spec.trackCenterX, 0, 0).applyQuaternion(quatG).add(ghost.position);
    this.tmpV3.set(1, 0, 0).applyQuaternion(quatG);
    this.tmpV3.y = 0;
    this.tmpV3.normalize();
    marks.update(dt, on, centerL, on, centerR, this.tmpV3);
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.rig.resize(window.innerWidth / window.innerHeight);
  }
}
