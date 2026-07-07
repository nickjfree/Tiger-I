/* ---------------------------------------------------------------------------
 * The single battle room.
 *
 * - up to MAX_PLAYERS humans; movement is client-authoritative (states are
 *   relayed in 20 Hz snapshots), damage/kills/respawns are decided here
 * - one resident AI tank, fully simulated server-side with the same physics
 *   and TankAI as singleplayer (it does not count toward the player limit)
 * - prop destruction is relayed + accumulated for late joiners
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import type { WebSocket } from 'ws';
import { Terrain } from '../src/world/Terrain';
import { Props } from '../src/world/Props';
import { Ground } from '../src/world/Ground';
import { TankAI, AITargetLike } from '../src/ai/TankAI';
import { SPECS, TankSpec } from '../src/tank/config';
import { intersectTankSegment, resolvePenetration, HitFacet } from '../src/sim/hittest';
import {
  ClientMsg, ServerMsg, EntityState, RosterEntry, PropEvent,
  MAX_PLAYERS, PROTOCOL_VERSION, RESPAWN_SECONDS, AI_RESPAWN_SECONDS, vec3, quat,
} from '../src/net/protocol';
import { HeadlessTank } from './HeadlessTank';

const TICK_HZ = 30;
const SNAP_HZ = 20;
const RESPAWN_S = RESPAWN_SECONDS;
const AI_RESPAWN_S = AI_RESPAWN_SECONDS;
const AI_ID = 'ai';

interface PlayerConn {
  id: string;
  ws: WebSocket;
  name: string;
  tank: TankSpec;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  state: EntityState;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  lastState: EntityState | null;
  lastStateAt: number;
  lastClaimAt: number;
  respawnAt: number;
  shim: AITargetLike;
}

interface ServerShell {
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  dist: number;
  age: number;
  spec: TankSpec; // shooter's spec (pen model)
}

export class Room {
  private readonly terrain = new Terrain();
  private readonly props = new Props(this.terrain);
  private readonly ground = new Ground(this.terrain, this.props);

  private readonly players = new Map<string, PlayerConn>();
  private readonly propEvents: PropEvent[] = [];

  private ai: HeadlessTank;
  private aiAI: TankAI;
  private aiKills = 0;
  private aiDeaths = 0;
  private aiRespawnAt = 0;
  private aiSpecId: 'tiger' | 't34' = 't34';
  private readonly aiIdleTarget: AITargetLike;

  private nextId = 1;
  private shells: ServerShell[] = [];
  private snapAcc = 0;
  private lastTick = Date.now();

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();

  constructor() {
    this.ai = new HeadlessTank(SPECS[this.aiSpecId], this.ground);
    this.aiIdleTarget = {
      position: new THREE.Vector3(0, this.ground.getHeight(0, 0), 0),
      destroyed: true, // "no target": AI halts (its update sees destroyed target)
      velocity: new THREE.Vector3(),
    };
    this.aiAI = new TankAI(this.ai, this.aiIdleTarget, this.ground);
    this.ai.placeAt(...this.findSpawn(null));

    setInterval(() => this.tick(), 1000 / TICK_HZ);
    console.log(`[room] ready — world seeded, AI (${this.ai.spec.displayName}) on patrol`);
  }

  get playerCount(): number {
    return this.players.size;
  }

  /* ------------------------------------------------------------------ */
  /* connections                                                         */
  /* ------------------------------------------------------------------ */

  handleConnection(ws: WebSocket): void {
    let player: PlayerConn | null = null;

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return;
      }

      if (msg.t === 'ping') {
        this.sendTo(ws, { t: 'pong', c: msg.c, s: Date.now() });
        return;
      }

      if (msg.t === 'hello') {
        if (player) return;
        if (msg.v !== PROTOCOL_VERSION) {
          this.sendTo(ws, { t: 'full' }); // version mismatch → treat as unjoinable
          ws.close();
          return;
        }
        if (this.players.size >= MAX_PLAYERS) {
          this.sendTo(ws, { t: 'full' });
          ws.close();
          return;
        }
        player = this.join(ws, msg.name, msg.tank === 'tiger' ? 'tiger' : 't34');
        return;
      }

      if (!player) return;

      switch (msg.t) {
        case 'st': {
          const p = player;
          p.state.p = msg.p;
          p.state.q = msg.q;
          p.state.ty = msg.ty;
          p.state.gp = msg.gp;
          p.state.vl = msg.vl;
          p.state.vr = msg.vr;
          p.state.mg = msg.mg;
          // derived vectors for AI targeting & server hit tests
          const now = Date.now();
          const dtMs = Math.max(16, now - p.lastStateAt);
          this.tmpV.set(msg.p[0], msg.p[1], msg.p[2]);
          p.velocity.copy(this.tmpV).sub(p.position).multiplyScalar(1000 / dtMs);
          if (p.velocity.lengthSq() > 40 * 40) p.velocity.setScalar(0); // teleport guard
          p.position.copy(this.tmpV);
          p.quaternion.set(msg.q[0], msg.q[1], msg.q[2], msg.q[3]);
          p.lastStateAt = now;
          break;
        }
        case 'fire':
          // relay to everyone else (their clients render a cosmetic tracer)
          this.broadcast({ t: 'fire', id: player.id, p: msg.p, d: msg.d, mv: msg.mv }, player.id);
          break;
        case 'claim':
          this.handleClaim(player, msg.target, msg.facet, msg.dist, msg.point);
          break;
        case 'prop':
          this.applyProp({ kind: msg.kind, index: msg.index, dx: msg.dx, dz: msg.dz }, player.id);
          break;
      }
    });

    ws.on('close', () => {
      if (!player) return;
      this.players.delete(player.id);
      this.broadcast({ t: 'leave', id: player.id, name: player.name });
      console.log(`[room] ${player.name} left (${this.players.size}/${MAX_PLAYERS})`);
    });
  }

  private join(ws: WebSocket, rawName: string, tank: 'tiger' | 't34'): PlayerConn {
    const id = `p${this.nextId++}`;
    const name = (String(rawName).trim() || 'Kommandant').slice(0, 16);
    const [sx, sz, syaw] = this.findSpawn(null);

    const state: EntityState = {
      id,
      p: [sx, this.ground.getHeight(sx, sz) + SPECS[tank].originHeight, sz],
      q: [0, Math.sin(syaw / 2), 0, Math.cos(syaw / 2)],
      ty: 0, gp: 0, vl: 0, vr: 0, mg: 0,
    };

    const player: PlayerConn = {
      id, ws, name,
      tank: SPECS[tank],
      hp: SPECS[tank].hp,
      alive: true,
      kills: 0,
      deaths: 0,
      state,
      position: new THREE.Vector3(state.p[0], state.p[1], state.p[2]),
      quaternion: new THREE.Quaternion(...state.q),
      velocity: new THREE.Vector3(),
      lastState: null,
      lastStateAt: Date.now(),
      lastClaimAt: 0,
      respawnAt: 0,
      shim: null as never,
    };
    player.shim = {
      position: player.position,
      velocity: player.velocity,
      get destroyed() {
        return !player.alive;
      },
    };
    this.players.set(id, player);

    this.sendTo(ws, {
      t: 'welcome',
      id,
      time: Date.now(),
      roster: this.roster(),
      props: this.propEvents,
      spawn: { x: sx, z: sz, yaw: syaw },
    });
    this.broadcast({ t: 'join', entry: this.rosterEntry(player) }, id);
    console.log(`[room] ${name} joined as ${SPECS[tank].displayName} (${this.players.size}/${MAX_PLAYERS})`);
    return player;
  }

  /* ------------------------------------------------------------------ */
  /* damage authority                                                    */
  /* ------------------------------------------------------------------ */

  private handleClaim(
    shooter: PlayerConn,
    targetId: string,
    facet: HitFacet,
    dist: number,
    point: [number, number, number],
  ): void {
    if (!shooter.alive) return;
    const now = Date.now();
    // one shell per reload cycle — reject spam claims
    if (now - shooter.lastClaimAt < shooter.tank.gun.reloadTime * 800) return;
    // plausibility: hit point within max effective range of the shooter
    this.tmpV.set(point[0], point[1], point[2]);
    if (this.tmpV.distanceTo(shooter.position) > 900) return;

    shooter.lastClaimAt = now;
    const meta = {
      pen0: shooter.tank.gun.penetration0,
      penFalloff: shooter.tank.gun.penetrationFalloff,
      damage: shooter.tank.gun.damage,
    };

    if (targetId === AI_ID) {
      if (this.ai.destroyed) return;
      const res = resolvePenetration(this.ai.spec, meta, facet, dist);
      this.applyDamage(AI_ID, shooter, res.penetrated, res.damage, facet, point);
    } else {
      const victim = this.players.get(targetId);
      if (!victim || !victim.alive) return;
      const res = resolvePenetration(victim.tank, meta, facet, dist);
      this.applyDamage(targetId, shooter, res.penetrated, res.damage, facet, point);
    }
  }

  private applyDamage(
    targetId: string,
    shooter: PlayerConn | 'ai',
    pen: boolean,
    damage: number,
    facet: HitFacet,
    point: [number, number, number],
  ): void {
    const byId = shooter === 'ai' ? AI_ID : shooter.id;
    let hp = 0;
    let killed = false;

    if (targetId === AI_ID) {
      if (pen) {
        this.ai.hp = Math.max(0, this.ai.hp - damage);
        killed = this.ai.hp <= 0;
        if (killed) {
          this.ai.destroyed = true;
          this.aiDeaths++;
          this.aiRespawnAt = Date.now() + AI_RESPAWN_S * 1000;
        }
      }
      hp = this.ai.hp;
    } else {
      const victim = this.players.get(targetId);
      if (!victim) return;
      if (pen) {
        victim.hp = Math.max(0, victim.hp - damage);
        killed = victim.hp <= 0;
        if (killed) {
          victim.alive = false;
          victim.deaths++;
          victim.respawnAt = Date.now() + RESPAWN_S * 1000;
        }
      }
      hp = victim.hp;
    }

    this.broadcast({
      t: 'hit',
      target: targetId,
      by: byId,
      facet,
      pen,
      damage: Math.round(damage),
      hp: Math.round(hp),
      killed,
      point,
    });

    if (killed) {
      const victimName = targetId === AI_ID ? this.ai.spec.displayName + ' (AI)' : this.players.get(targetId)!.name;
      const byName = shooter === 'ai' ? this.ai.spec.displayName + ' (AI)' : shooter.name;
      if (shooter === 'ai') this.aiKills++;
      else shooter.kills++;
      this.broadcast({ t: 'kill', by: byId, byName, victim: targetId, victimName });
      this.broadcastScores();
    }
  }

  /* ------------------------------------------------------------------ */
  /* tick                                                                */
  /* ------------------------------------------------------------------ */

  private tick(): void {
    const now = Date.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.08);
    this.lastTick = now;

    this.updateAI(dt, now);
    this.updateShells(dt);
    this.updateRespawns(now);

    this.snapAcc += dt;
    if (this.snapAcc >= 1 / SNAP_HZ) {
      this.snapAcc = 0;
      this.broadcast({ t: 'snap', time: now, s: this.snapshotStates() });
    }
  }

  private updateAI(dt: number, now: number): void {
    // retarget: nearest alive player
    let nearest: PlayerConn | null = null;
    let best = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = p.position.distanceTo(this.ai.position);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    this.aiAI.setTarget(nearest ? nearest.shim : this.aiIdleTarget);

    const cmd = this.aiAI.update(dt);
    const fired = this.ai.update(dt, cmd.drive, cmd.aimDir, cmd.triggers.fireMain);
    if (fired) {
      this.broadcast({
        t: 'fire',
        id: AI_ID,
        p: vec3(fired.firedFrom),
        d: vec3(fired.firedDir),
        mv: this.ai.spec.gun.muzzleVelocity,
      });
      this.shells.push({
        pos: fired.firedFrom.clone(),
        prev: fired.firedFrom.clone(),
        vel: fired.firedDir.clone().multiplyScalar(this.ai.spec.gun.muzzleVelocity),
        dist: 0,
        age: 0,
        spec: this.ai.spec,
      });
    }

    // AI hull vs props: crush + broadcast (mirrors the client behavior)
    if (!this.ai.destroyed) this.aiCrushProps();

    // AI vs players: one-sided separation (server can only move the AI)
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const ra = (this.ai.spec.hitbox.halfW + this.ai.spec.hitbox.halfL) * 0.52;
      const rb = (p.tank.hitbox.halfW + p.tank.hitbox.halfL) * 0.52;
      const dx = this.ai.position.x - p.position.x;
      const dz = this.ai.position.z - p.position.z;
      const d = Math.hypot(dx, dz);
      const overlap = ra + rb - d;
      if (overlap > 0 && d > 1e-4) {
        const b = this.ai.physics.body;
        b.force.x += (dx / d) * overlap * 2e6;
        b.force.z += (dz / d) * overlap * 2e6;
      }
    }
  }

  private aiCrushProps(): void {
    const pos = this.ai.position;
    const fwd = this.ai.forward;
    const hw = this.ai.spec.hitbox.halfW + 0.1;
    const hl = this.ai.spec.hitbox.halfL + 0.2;
    const inv = this.tmpV2; // reuse as scratch quaternion-free local test

    for (const i of this.props.standingTreesNear(pos.x, pos.z)) {
      const t = this.props.trees[i];
      // cheap OBB via forward projection
      inv.set(t.x - pos.x, 0, t.z - pos.z);
      const lz = inv.x * fwd.x + inv.z * fwd.z;
      const lx = inv.x * fwd.z - inv.z * fwd.x;
      if (Math.abs(lx) < hw && Math.abs(lz) < hl) {
        this.applyProp({ kind: 'tree', index: i, dx: fwd.x, dz: fwd.z }, null);
      }
    }
    for (const i of this.props.standingFencesNear(pos.x, pos.z)) {
      const f = this.props.fences[i];
      inv.set(f.x - pos.x, 0, f.z - pos.z);
      const lz = inv.x * fwd.x + inv.z * fwd.z;
      const lx = inv.x * fwd.z - inv.z * fwd.x;
      if (Math.abs(lx) < hw + 0.1 && Math.abs(lz) < hl + 0.1) {
        this.applyProp({ kind: 'fence', index: i, dx: fwd.x, dz: fwd.z }, null);
      }
    }
    for (let i = 0; i < this.props.sheds.length; i++) {
      const sh = this.props.sheds[i];
      if (!sh.intact) continue;
      if (Math.hypot(sh.x - pos.x, sh.z - pos.z) < sh.radius + 1.7) {
        this.applyProp({ kind: 'shed', index: i, dx: fwd.x, dz: fwd.z }, null);
      }
    }
  }

  private applyProp(ev: PropEvent, fromId: string | null): void {
    // idempotent state application + record for late joiners
    if (ev.kind === 'tree') {
      const t = this.props.trees[ev.index];
      if (!t || t.state !== 0) return;
      this.props.fellTree(ev.index, ev.dx, ev.dz);
    } else if (ev.kind === 'fence') {
      const f = this.props.fences[ev.index];
      if (!f || f.state !== 0) return;
      this.props.breakFence(ev.index, ev.dx, ev.dz);
    } else {
      const sh = this.props.sheds[ev.index];
      if (!sh || !sh.intact) return;
      sh.intact = false; // server needs no debris
    }
    this.propEvents.push(ev);
    this.broadcast({ t: 'prop', ...ev }, fromId ?? undefined);
  }

  /** Server-simulated AI shells vs terrain and player hitboxes. */
  private updateShells(dt: number): void {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.age += dt;
      s.prev.copy(s.pos);
      s.vel.y -= 9.81 * dt;
      s.vel.multiplyScalar(1 - 0.012 * dt);
      s.pos.addScaledVector(s.vel, dt);
      s.dist += s.prev.distanceTo(s.pos);

      let consumed = false;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const hit = intersectTankSegment(
          s.prev, s.pos,
          { position: p.position, quaternion: p.quaternion, turretYaw: p.state.ty },
          p.tank.hitbox,
        );
        if (!hit) continue;
        const meta = {
          pen0: s.spec.gun.penetration0,
          penFalloff: s.spec.gun.penetrationFalloff,
          damage: s.spec.gun.damage,
        };
        const res = resolvePenetration(p.tank, meta, hit.facet, s.dist);
        this.applyDamage(p.id, 'ai', res.penetrated, res.damage, hit.facet, vec3(hit.point));
        consumed = true;
        break;
      }
      if (consumed || s.age > 9 || s.pos.y <= this.ground.getHeight(s.pos.x, s.pos.z)) {
        this.shells.splice(i, 1);
      }
    }
  }

  private updateRespawns(now: number): void {
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) {
        p.respawnAt = 0;
        p.alive = true;
        p.hp = p.tank.hp;
        const [x, z, yaw] = this.findSpawn(p.id);
        this.broadcast({ t: 'spawn', id: p.id, x, z, yaw, hp: p.hp });
      }
    }
    if (this.ai.destroyed && this.aiRespawnAt > 0 && now >= this.aiRespawnAt) {
      this.aiRespawnAt = 0;
      // alternate vehicle for variety
      this.aiSpecId = this.aiSpecId === 't34' ? 'tiger' : 't34';
      this.ai = new HeadlessTank(SPECS[this.aiSpecId], this.ground);
      this.aiAI = new TankAI(this.ai, this.aiIdleTarget, this.ground);
      const [x, z, yaw] = this.findSpawn(null);
      this.ai.placeAt(x, z, yaw);
      this.broadcast({ t: 'spawn', id: AI_ID, x, z, yaw, hp: this.ai.hp });
      // roster entry changes tank type — resend as join (clients replace)
      this.broadcast({ t: 'join', entry: this.aiRosterEntry() });
    }
  }

  /** Flat, unobstructed spot far from every living tank. */
  private findSpawn(excludeId: string | null): [number, number, number] {
    let best: [number, number, number] = [0, 0, 0];
    let bestScore = -Infinity;
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 60 + Math.random() * 220;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      if (this.ground.getNormal(x, z).y < 0.94) continue;
      if (this.props.rockBumpAt(x, z) > this.terrain.getHeight(x, z) + 0.05) continue;
      if (this.props.sheds.some((s) => s.intact && Math.hypot(s.x - x, s.z - z) < s.radius + 6)) continue;

      let minDist = Infinity;
      for (const p of this.players.values()) {
        if (p.id === excludeId || !p.alive) continue;
        minDist = Math.min(minDist, Math.hypot(p.position.x - x, p.position.z - z));
      }
      if (!this.ai.destroyed && excludeId !== AI_ID) {
        minDist = Math.min(minDist, Math.hypot(this.ai.position.x - x, this.ai.position.z - z));
      }
      const score = minDist === Infinity ? 200 + Math.random() * 50 : Math.min(minDist, 400);
      if (score > bestScore) {
        bestScore = score;
        best = [x, z, Math.atan2(-x, -z)]; // face map center
      }
      if (bestScore > 180) break;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* serialization                                                       */
  /* ------------------------------------------------------------------ */

  private aiState(): EntityState {
    return {
      id: AI_ID,
      p: vec3(this.ai.position),
      q: quat(this.ai.hullQuaternion),
      ty: +this.ai.turret.yaw.toFixed(3),
      gp: +this.ai.turret.pitch.toFixed(3),
      vl: +this.ai.physics.trackSpeedLeft.toFixed(2),
      vr: +this.ai.physics.trackSpeedRight.toFixed(2),
      mg: 0,
    };
  }

  private snapshotStates(): EntityState[] {
    const out: EntityState[] = [this.aiState()];
    for (const p of this.players.values()) out.push(p.state);
    return out;
  }

  private aiRosterEntry(): RosterEntry {
    return {
      id: AI_ID,
      name: `${this.ai.spec.displayName} (AI)`,
      tank: this.ai.spec.id,
      hp: this.ai.hp,
      alive: !this.ai.destroyed,
      kills: this.aiKills,
      deaths: this.aiDeaths,
      ai: true,
      state: this.aiState(),
    };
  }

  private rosterEntry(p: PlayerConn): RosterEntry {
    return {
      id: p.id,
      name: p.name,
      tank: p.tank.id,
      hp: p.hp,
      alive: p.alive,
      kills: p.kills,
      deaths: p.deaths,
      ai: false,
      state: p.state,
    };
  }

  private roster(): RosterEntry[] {
    const out = [this.aiRosterEntry()];
    for (const p of this.players.values()) out.push(this.rosterEntry(p));
    return out;
  }

  private broadcastScores(): void {
    const s = [{ id: AI_ID, kills: this.aiKills, deaths: this.aiDeaths }];
    for (const p of this.players.values()) s.push({ id: p.id, kills: p.kills, deaths: p.deaths });
    this.broadcast({ t: 'scores', s });
  }

  /* ------------------------------------------------------------------ */

  private sendTo(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg, exceptId?: string): void {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue;
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
  }
}
