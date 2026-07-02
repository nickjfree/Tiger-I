# Tiger I Simulator

A realistic, fully procedural browser-based **Tiger I (late production)** tank simulator.
Built with **Three.js + TypeScript + Vite**, rigid-body physics via **cannon-es**.
No downloaded assets — the model, terrain, textures (camouflage, Zimmerit), particles
and even all audio are generated in code.

## Run it

```bash
npm install
npm run dev        # → http://localhost:5173
npm run build      # typecheck + production build in dist/
```

## Controls

| Input | Action |
| --- | --- |
| `W` / `S` | Drive forward / reverse |
| `A` / `D` | Differential track steering (pivot turn when stationary) |
| `X` | Brake |
| Mouse | Aim turret & gun (rate-limited hydraulic traverse) |
| Mouse wheel | Camera zoom |
| `LMB` | Fire 8.8 cm KwK 36 |
| `RMB` (hold) | Gunner sight (TZF) zoom view |
| `Space` (hold) | Coaxial MG 34 |
| `F` (hold) | Hull MG 34 (fixed ball mount, fires along hull) |
| `T` | Recover from a rollover |
| `M` / `H` | Mute audio / toggle help |

Click the canvas to lock the pointer and take command. Seven practice targets
are scattered around the spawn (see minimap) — knock them all down.

## Architecture

```
src/
├─ main.ts                  bootstrap
├─ core/
│  ├─ Game.ts               renderer + master update loop, wiring
│  ├─ Input.ts              keyboard / pointer-lock mouse
│  └─ CameraRig.ts          chase orbit camera + gunner sight mode
├─ world/
│  ├─ Terrain.ts            analytic fBm heightfield + mesh + props
│  ├─ Environment.ts        gradient-shader sky, sun/shadows, fog
│  └─ Targets.ts            practice targets that tip over when hit
├─ tank/
│  ├─ config.ts             ★ single source of truth for all dimensions
│  ├─ TankPhysics.ts        cannon-es body + 16-station spring suspension,
│  │                        per-track drive/friction (differential steering)
│  ├─ TigerModel.ts         procedural late-production Tiger I mesh
│  ├─ materials.ts          procedural camo + Zimmerit bump PBR materials
│  ├─ Tracks.ts             instanced track links on a live, wheel-conforming path
│  ├─ Gun.ts                turret/gun fire control, recoil, MGs
│  └─ Tank.ts               facade: physics ↔ visuals ↔ effects sync
├─ effects/
│  ├─ Particles.ts          2 pooled Points systems + concrete effects
│  └─ Projectiles.ts        ballistic shells & bullets, impact handling
├─ ui/HUD.ts                speed/ammo panels, minimap, reticles, ticker
└─ audio/AudioManager.ts    synthesized engine/tracks/cannon/MG audio
```

### How the key systems work

**Suspension & movement** — the hull is one cannon-es rigid body. 16 suspension
stations (8 interleaved axles per side, like the real torsion-bar layout) sample
the *analytic* terrain height each 1/120 s substep and apply spring–damper forces,
plus longitudinal drive and lateral friction forces at each contact. Each side
chases its own commanded track speed, so `A`/`D` produce true differential
steering — including neutral pivot turns, which the Tiger's regenerative
steering gear could really do.

**Tracks** — each side is a single `InstancedMesh` of ~110 links. Every frame a
closed 2D path is rebuilt from the live wheel heights: bottom run hugging the
wheel bottoms (terrain conforming), wrap arcs around sprocket and idler, and a
return run riding the wheel tops with sag dips between supports (the Tiger had
no return rollers). Links are distributed by arc length and scrolled by the
track's actual ground speed, so contact links appear stationary on the ground.

**Ballistics** — shells leave the muzzle with proper gravity + drag integration;
impacts are found by sweeping the movement segment against the terrain function
and target spheres. Muzzle velocity is scaled down (773 → 340 m/s) so trajectories
read at the 640 m map scale — tune in `config.ts`.

**Tuning** — nearly every gameplay-relevant number (speeds, spring rates,
traverse rate, reload time, muzzle velocity…) lives in `src/tank/config.ts`.

## Extending

- New vehicles: implement another `config` + model, reuse `TankPhysics`/`Tracks`.
- Enemy AI: give `Targets` a `Tank` instance and drive its `DriveInput`.
- Damage model: hook `Projectiles.onImpact` — hit positions are already exact.
- Real audio: swap `AudioManager` internals for buffer playback; the call sites
  (`playCannon`, `update(load, speed)`, …) stay the same.
