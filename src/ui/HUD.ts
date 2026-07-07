/* ---------------------------------------------------------------------------
 * DOM overlay HUD: speed & engine, ammo & reload, minimap (pre-rendered
 * terrain + live tank/turret/target markers), crosshair + live gun-direction
 * marker, gunner-sight reticle, ticker messages and a help panel.
 * ------------------------------------------------------------------------ */

import * as THREE from 'three';
import { Terrain } from '../world/Terrain';
import { clamp } from '../utils/math';

export interface HUDState {
  speedKmh: number;
  engineLoad: number;
  ammo: number;
  reloadProgress: number; // 0..1, 1 = ready
  tankPos: THREE.Vector3;
  hullYaw: number; // radians, world
  turretYaw: number; // radians, hull-local
  gunAimPoint: THREE.Vector3; // world point the barrel points at
  sightMode: boolean;
  locked: boolean;
  muted: boolean;
  targets: Array<{ x: number; z: number; alive: boolean }>;
  playerHp: number;
  playerMaxHp: number;
  enemy: { x: number; z: number; alive: boolean; hp: number; maxHp: number; name: string } | null;
  /** Multiplayer: all remote tanks for the minimap. */
  remotes?: Array<{ x: number; z: number; alive: boolean }>;
}

export interface ScoreRow {
  name: string;
  tank: string;
  kills: number;
  deaths: number;
  me: boolean;
  ai: boolean;
  alive: boolean;
}

const MAP_SIZE = 168;

export class HUD {
  private readonly root: HTMLDivElement;
  private readonly speedEl: HTMLElement;
  private readonly rpmBar: HTMLElement;
  private readonly ammoEl: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly reloadWrap: HTMLElement;
  private readonly readyEl: HTMLElement;
  private readonly headingEl: HTMLElement;
  private readonly tickerEl: HTMLElement;
  private readonly helpPanel: HTMLElement;
  private readonly lockHint: HTMLElement;
  private readonly gunMarker: HTMLElement;
  private readonly sightEl: HTMLElement;
  private readonly crosshairEl: HTMLElement;

  private readonly playerHpBar: HTMLElement;
  private readonly enemyPanel: HTMLElement;
  private readonly enemyHpBar: HTMLElement;
  private readonly enemyName: HTMLElement;
  private readonly hitmarkerEl: HTMLElement;
  private readonly dmgFlashEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private hitmarkerTtl = 0;
  private dmgTtl = 0;
  private enemyVisibleTtl = 0;

  private readonly mapCanvas: HTMLCanvasElement;
  private readonly mapCtx: CanvasRenderingContext2D;
  private readonly mapBase: HTMLCanvasElement;

  private tickerTtl = 0;
  private helpVisible = true;

  private killfeedEl!: HTMLElement;
  private scoreboardEl!: HTMLElement;
  private respawnEl!: HTMLElement;
  private onlinePanel!: HTMLElement;

  private readonly proj = new THREE.Vector3();

  constructor(container: HTMLElement, private readonly terrain: Terrain) {
    this.root = document.createElement('div');
    this.root.innerHTML = /* html */ `
      <div class="hud" id="vignette"></div>
      <div class="hud" id="crosshair"></div>
      <div class="hud" id="gun-marker"></div>
      <div class="hud" id="sight">
        <div class="ring"></div><div class="vline"></div><div class="hline"></div>
        <div class="chevron">▲</div>
      </div>

      <div class="hud hud-panel" id="drive-panel">
        <div><span class="big" id="speed">0</span> <span class="unit">km/h</span></div>
        <div class="unit" id="engine-label">MAYBACH HL230 P45</div>
        <div class="bar"><div id="rpm"></div></div>
        <div class="unit" style="margin-top:6px">PANZERUNG</div>
        <div class="bar"><div id="player-hp" class="hp"></div></div>
      </div>

      <div class="hud hud-panel" id="enemy-panel">
        <div class="label" id="enemy-name">FEIND</div>
        <div class="bar"><div id="enemy-hp" class="hp enemy"></div></div>
      </div>

      <div class="hud" id="hitmarker"></div>
      <div class="hud" id="dmg-flash"></div>
      <div class="hud" id="banner">
        <div id="banner-title"></div>
        <div id="banner-sub"></div>
      </div>

      <div class="hud hud-panel" id="ammo-panel">
        <div class="label" id="gun-label">8.8cm KwK 36 L/56 — PzGr.39</div>
        <div><span class="shell-count" id="ammo">40</span> <span class="unit">rounds</span></div>
        <div class="bar" id="reload-bar-wrap"><div id="reload-bar"></div></div>
        <div class="ready" id="ready">BEREIT</div>
        <div class="label" id="mute-note"></div>
      </div>

      <div class="hud hud-panel" id="minimap-panel">
        <canvas id="minimap" width="${MAP_SIZE}" height="${MAP_SIZE}"></canvas>
        <div id="heading">000°</div>
      </div>

      <div class="hud" id="ticker"></div>
      <div class="hud" id="killfeed"></div>
      <div class="hud hud-panel" id="scoreboard"><table><tbody id="score-rows"></tbody></table></div>
      <div class="hud" id="respawn-overlay">
        <div id="respawn-title">ABGESCHOSSEN</div>
        <div id="respawn-sub"></div>
      </div>
      <div class="hud hud-panel" id="online-panel"></div>

      <div class="hud hud-panel" id="help-panel">
        <h3 id="help-title">CONTROLS</h3>
        <div><kbd>W</kbd><kbd>S</kbd> drive · <kbd>A</kbd><kbd>D</kbd> steer tracks</div>
        <div><kbd>X</kbd> brake · <kbd>T</kbd> recover flip</div>
        <div>Mouse — aim turret · Wheel — zoom</div>
        <div><kbd>LMB</kbd> fire main gun · <kbd>RMB</kbd> gun sight</div>
        <div><kbd>Space</kbd> coax MG · <kbd>F</kbd> hull MG</div>
        <div><kbd>M</kbd> mute · <kbd>H</kbd> toggle help</div>
      </div>

      <div class="hud" id="lock-hint">CLICK TO TAKE COMMAND</div>
    `;
    container.appendChild(this.root);

    const q = <T extends HTMLElement>(id: string): T => this.root.querySelector(`#${id}`) as T;
    this.speedEl = q('speed');
    this.rpmBar = q('rpm');
    this.ammoEl = q('ammo');
    this.reloadBar = q('reload-bar');
    this.reloadWrap = q('reload-bar-wrap');
    this.readyEl = q('ready');
    this.headingEl = q('heading');
    this.tickerEl = q('ticker');
    this.helpPanel = q('help-panel');
    this.lockHint = q('lock-hint');
    this.gunMarker = q('gun-marker');
    this.sightEl = q('sight');
    this.crosshairEl = q('crosshair');
    this.playerHpBar = q('player-hp');
    this.enemyPanel = q('enemy-panel');
    this.enemyHpBar = q('enemy-hp');
    this.enemyName = q('enemy-name');
    this.hitmarkerEl = q('hitmarker');
    this.dmgFlashEl = q('dmg-flash');
    this.bannerEl = q('banner');
    this.mapCanvas = q('minimap');
    this.mapCtx = this.mapCanvas.getContext('2d')!;
    this.killfeedEl = q('killfeed');
    this.scoreboardEl = q('scoreboard');
    this.respawnEl = q('respawn-overlay');
    this.onlinePanel = q('online-panel');

    this.mapBase = this.renderMapBase();
  }

  /** Pre-render the terrain (color + slope shading) once. */
  private renderMapBase(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = MAP_SIZE;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(MAP_SIZE, MAP_SIZE);
    const half = this.terrain.size / 2;
    const c = new THREE.Color();
    const n = new THREE.Vector3();

    for (let py = 0; py < MAP_SIZE; py++) {
      for (let px = 0; px < MAP_SIZE; px++) {
        // map pixel → world (north/−Z at top)
        const wx = (px / MAP_SIZE) * this.terrain.size - half;
        const wz = (py / MAP_SIZE) * this.terrain.size - half;
        const h = this.terrain.getHeight(wx, wz);
        this.terrain.groundColor(wx, wz, h, c);
        this.terrain.getNormal(wx, wz, n);
        const shade = 0.62 + n.x * 0.55; // fake NW sun
        const i = (py * MAP_SIZE + px) * 4;
        img.data[i + 0] = clamp(c.r * shade * 255, 0, 255);
        img.data[i + 1] = clamp(c.g * shade * 255, 0, 255);
        img.data[i + 2] = clamp(c.b * shade * 255, 0, 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Label the HUD for the chosen tank. */
  setMatchInfo(engineLabel: string, gunLabel: string, enemyName: string, playerName = ''): void {
    if (playerName) {
      (this.root.querySelector('#help-title') as HTMLElement).textContent = `${playerName.toUpperCase()} — CONTROLS`;
    }
    (this.root.querySelector('#engine-label') as HTMLElement).textContent = engineLabel;
    (this.root.querySelector('#gun-label') as HTMLElement).textContent = gunLabel;
    this.enemyName.textContent = enemyName;
  }

  /** Feedback when the player's shell strikes the enemy. */
  hitmarker(kind: 'penetration' | 'ricochet' | 'kill'): void {
    this.hitmarkerTtl = 0.6;
    this.hitmarkerEl.className = 'hud hm-' + kind;
    this.hitmarkerEl.textContent =
      kind === 'kill' ? 'ABSCHUSS!' : kind === 'penetration' ? 'DURCHSCHLAG' : 'ABPRALLER';
    this.enemyVisibleTtl = 6;
  }

  /** Red flash when the player is hit. */
  damageFlash(): void {
    this.dmgTtl = 0.7;
  }

  showBanner(title: string, sub: string, win: boolean): void {
    this.bannerEl.style.display = 'block';
    this.bannerEl.classList.toggle('win', win);
    (this.root.querySelector('#banner-title') as HTMLElement).textContent = title;
    (this.root.querySelector('#banner-sub') as HTMLElement).textContent = sub;
  }

  showMessage(text: string): void {
    this.tickerEl.textContent = text;
    this.tickerEl.style.opacity = '1';
    this.tickerTtl = 3.2;
  }

  toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
    this.helpPanel.style.display = this.helpVisible ? 'block' : 'none';
  }

  /** Multiplayer kill feed line (top-left, self-expiring). */
  addKillFeed(text: string): void {
    const line = document.createElement('div');
    line.className = 'kf-line';
    line.textContent = text;
    this.killfeedEl.appendChild(line);
    while (this.killfeedEl.children.length > 5) this.killfeedEl.firstChild?.remove();
    setTimeout(() => line.classList.add('fade'), 4500);
    setTimeout(() => line.remove(), 5600);
  }

  setScoreboardVisible(v: boolean): void {
    this.scoreboardEl.style.display = v ? 'block' : 'none';
  }

  setScoreboard(rows: ScoreRow[]): void {
    const tbody = this.scoreboardEl.querySelector('#score-rows') as HTMLElement;
    tbody.innerHTML =
      '<tr><th>COMMANDER</th><th>TANK</th><th>KILLS</th><th>DEATHS</th></tr>' +
      rows
        .map(
          (r) =>
            `<tr class="${r.me ? 'me' : ''}${r.alive ? '' : ' dead'}"><td>${escapeHtml(r.name)}${r.ai ? ' 🤖' : ''}</td>` +
            `<td>${r.tank}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`,
        )
        .join('');
  }

  /** Respawn countdown overlay; pass null to hide. */
  showRespawn(seconds: number | null): void {
    if (seconds === null) {
      this.respawnEl.style.display = 'none';
      return;
    }
    this.respawnEl.style.display = 'block';
    (this.respawnEl.querySelector('#respawn-sub') as HTMLElement).textContent =
      `Respawn in ${Math.max(0, seconds).toFixed(0)}s`;
  }

  /** "N/8 ONLINE" pill; pass null to hide (singleplayer). */
  setOnlineCount(text: string | null): void {
    this.onlinePanel.style.display = text ? 'block' : 'none';
    if (text) this.onlinePanel.textContent = text;
  }

  update(dt: number, s: HUDState, camera: THREE.PerspectiveCamera): void {
    // ---- drive ----
    this.speedEl.textContent = Math.abs(s.speedKmh).toFixed(0);
    this.rpmBar.style.width = `${clamp(20 + s.engineLoad * 80, 0, 100)}%`;

    // ---- health ----
    const hpFrac = clamp(s.playerHp / s.playerMaxHp, 0, 1);
    this.playerHpBar.style.width = `${(hpFrac * 100).toFixed(0)}%`;
    this.playerHpBar.classList.toggle('low', hpFrac < 0.35);
    if (s.enemy) {
      this.enemyVisibleTtl -= dt;
      this.enemyPanel.style.display = this.enemyVisibleTtl > 0 ? 'block' : 'none';
      this.enemyHpBar.style.width = `${((s.enemy.hp / s.enemy.maxHp) * 100).toFixed(0)}%`;
    } else {
      this.enemyPanel.style.display = 'none';
    }

    // ---- hitmarker / damage flash ----
    if (this.hitmarkerTtl > 0) {
      this.hitmarkerTtl -= dt;
      this.hitmarkerEl.style.opacity = String(clamp(this.hitmarkerTtl / 0.25, 0, 1));
    }
    if (this.dmgTtl > 0) {
      this.dmgTtl -= dt;
      this.dmgFlashEl.style.opacity = String(clamp(this.dmgTtl, 0, 0.55));
    }

    // ---- ammo / reload ----
    this.ammoEl.textContent = String(s.ammo);
    const ready = s.reloadProgress >= 1;
    this.reloadWrap.style.display = ready ? 'none' : 'block';
    this.readyEl.style.display = ready ? 'block' : 'none';
    this.reloadBar.style.width = `${(s.reloadProgress * 100).toFixed(0)}%`;

    // ---- gun marker: project barrel aim point to screen ----
    this.proj.copy(s.gunAimPoint).project(camera);
    const behind = this.proj.z > 1;
    if (behind || s.sightMode) {
      this.gunMarker.style.opacity = '0';
    } else {
      this.gunMarker.style.opacity = '0.9';
      this.gunMarker.style.left = `${((this.proj.x + 1) / 2) * 100}%`;
      this.gunMarker.style.top = `${((1 - this.proj.y) / 2) * 100}%`;
    }

    // ---- sight overlay ----
    this.sightEl.style.display = s.sightMode ? 'block' : 'none';
    this.crosshairEl.style.display = s.sightMode ? 'none' : 'block';

    // ---- minimap ----
    this.drawMap(s);

    const deg = ((-s.hullYaw * 180) / Math.PI + 360) % 360;
    this.headingEl.textContent = `${deg.toFixed(0).padStart(3, '0')}°`;

    // ---- ticker ----
    if (this.tickerTtl > 0) {
      this.tickerTtl -= dt;
      if (this.tickerTtl <= 0) this.tickerEl.style.opacity = '0';
    }

    this.lockHint.style.display = s.locked ? 'none' : 'block';
    // note about mute state
    const note = this.root.querySelector('#mute-note') as HTMLElement;
    note.textContent = s.muted ? 'AUDIO MUTED (M)' : '';
  }

  private drawMap(s: HUDState): void {
    const ctx = this.mapCtx;
    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.drawImage(this.mapBase, 0, 0);

    const half = this.terrain.size / 2;
    const toPx = (x: number, z: number): [number, number] => [
      ((x + half) / this.terrain.size) * MAP_SIZE,
      ((z + half) / this.terrain.size) * MAP_SIZE,
    ];

    // targets
    for (const t of s.targets) {
      const [tx, ty] = toPx(t.x, t.z);
      ctx.fillStyle = t.alive ? '#e04c30' : '#5c5c54';
      ctx.beginPath();
      ctx.arc(tx, ty, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // multiplayer: all remote tanks as red diamonds
    if (s.remotes) {
      for (const r of s.remotes) {
        const [ex, ey] = toPx(r.x, r.z);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = r.alive ? '#ff5040' : '#544f49';
        ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
        ctx.restore();
      }
    }

    // enemy tank (red diamond)
    if (s.enemy) {
      const [ex, ey] = toPx(s.enemy.x, s.enemy.z);
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = s.enemy.alive ? '#ff5040' : '#544f49';
      ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
      ctx.restore();
    }

    // tank hull triangle + turret line
    const [px, py] = toPx(s.tankPos.x, s.tankPos.z);
    ctx.save();
    ctx.translate(px, py);
    // world yaw θ rotates +Z toward +X; map has +X→right, +Z→down.
    ctx.rotate(-s.hullYaw + Math.PI);
    ctx.fillStyle = '#f0ead0';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    // turret direction
    ctx.rotate(-s.turretYaw);
    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -11);
    ctx.stroke();
    ctx.restore();

    // frame
    ctx.strokeStyle = 'rgba(190,180,140,0.4)';
    ctx.strokeRect(0.5, 0.5, MAP_SIZE - 1, MAP_SIZE - 1);
  }
}

function escapeHtml(t: string): string {
  return t.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string);
}
