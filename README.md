# Panzer Duel 1944 — Tiger I vs T-34-85

A realistic, fully procedural browser-based tank duel: **Tiger I (late production)**
versus **T-34-85**, both historically dimensioned and armored. Pick either tank at
the start screen — an AI commander takes the other and hunts you. First kill wins.
Built with **Three.js + TypeScript + Vite**, rigid-body physics via **cannon-es**.
No downloaded assets — models, terrain, textures, particles and all audio are
generated in code.

## The duel

- **Historical armor model** — every shell resolves against the facet it strikes
  (glacis / sides / rear / turret) using effective-thickness values and real
  penetration-vs-range curves (PzGr.39 APCBC, BR-365 APHE). The 88 defeats the
  T-34 anywhere; the 85 mm bounces off the Tiger's front and mantlet and must
  close in or flank — exactly the 1944 dynamic.
- **AI doctrine per tank** — the Tiger AI halts and snipes from range; the
  T-34 AI keeps moving, circles, and works your flanks. Both use full ballistic
  firing solutions with target lead, terrain line-of-sight and the same physics,
  traverse limits and reload times the player has.
- **Per-tank feel** — 53 km/h vs 40 km/h, diesel clatter vs petrol snarl, gun
  reports, reload times, turret speeds, gun depression… all from the spec table
  in `src/tank/config.ts`.

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
│  ├─ Terrain.ts            analytic fBm heightfield + mesh
│  ├─ Props.ts              trees/rocks/bushes/fences/sheds — spatial-hash
│  │                        indexed, crushable/destructible game objects
│  ├─ Ground.ts             unified ground sampler (terrain + rock domes) —
│  │                        suspension & shells ride over obstacles
│  ├─ Environment.ts        gradient-shader sky, sun/shadows, fog
│  └─ Targets.ts            practice targets (shoot them or run them down)
├─ ai/TankAI.ts             enemy commander: hunt/flank/engage + gunnery
├─ tank/
│  ├─ config.ts             ★ TankSpec table: TIGER + T34 (dims, armor, guns, AI)
│  ├─ TankPhysics.ts        cannon-es body + 16-station spring suspension,
│  │                        per-track drive/friction (differential steering)
│  ├─ TigerModel.ts         procedural late-production Tiger I mesh
│  ├─ T34Model.ts           procedural T-34-85 mesh (sloped hull, cast turret)
│  ├─ materials.ts          procedural camo + Zimmerit bump PBR materials
│  ├─ Tracks.ts             instanced track links on a live, wheel-conforming path
│  ├─ Gun.ts                turret/gun fire control, recoil, MGs
│  └─ Tank.ts               facade: physics ↔ visuals ↔ effects sync
├─ effects/
│  ├─ Particles.ts          2 pooled Points systems + concrete effects
│  ├─ Projectiles.ts        ballistic shells & bullets, impact handling
│  ├─ Debris.ts             flying wreckage pieces (bounce, rest, fade)
│  └─ TrackMarks.ts         cleated track imprints left on the ground
├─ ui/HUD.ts                speed/ammo/health, minimap, hitmarkers, banners
├─ ui/Menu.ts               tank selection screen
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
