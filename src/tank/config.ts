/* ---------------------------------------------------------------------------
 * Tank specifications — the single source of truth for every vehicle.
 *
 * Two historical adversaries of 1944:
 *
 *  TIGER I (late production)                    T-34-85
 *  ─ 57 t · Maybach HL230 700 PS petrol         ─ 32 t · V-2-34 500 hp diesel
 *  ─ 8.8 cm KwK 36 L/56 · 773 m/s               ─ 85 mm ZiS-S-53 L/54.6 · 792 m/s
 *  ─ hull 100 mm vertical, turret 100–120       ─ 45 mm @ 60° glacis, turret 90 cast
 *  ─ 45.4 km/h governed ~40                     ─ 53 km/h
 *
 * Armor values below are EFFECTIVE thickness (slope already folded in, mm).
 * Penetration follows pen(d) = pen0 − falloff·d (meters, real-scale RHA data
 * for PzGr.39 APCBC and BR-365 APHE respectively). At this map's 100–400 m
 * engagements the historical matchup emerges naturally: the 88 defeats the
 * T-34 anywhere; the 85 mm bounces off the Tiger's front and must close in
 * or flank.
 *
 * Coordinates: +Z forward, +Y up, origin at hull center `originHeight` above
 * flat ground at rest.
 * ------------------------------------------------------------------------ */

export interface GunSpec {
  label: string;
  elevationMax: number;
  depressionMax: number;
  traverseRate: number; // rad/s
  elevateRate: number; // rad/s
  muzzleVelocity: number; // m/s (scaled for map size; both tanks scaled alike)
  reloadTime: number; // s
  ammo: number;
  recoilDistance: number;
  recoilImpulse: number; // N·s applied to hull
  penetration0: number; // mm RHA at muzzle
  penetrationFalloff: number; // mm lost per meter of flight
  damage: [number, number]; // hp damage per penetrating hit [min, max]
  sound: 'kwk36' | 'zis53';
}

/** Effective armor per facet (mm, slope included). */
export interface ArmorSpec {
  hullFront: number;
  hullSide: number;
  hullRear: number;
  turretFront: number;
  turretSide: number;
  turretRear: number;
  top: number;
}

export interface AISpec {
  engageRange: number; // m: open fire within this if line-of-sight
  preferredRange: number; // m: distance it tries to keep
  keepMoving: boolean; // true = fires on the move / circles (T-34 doctrine)
  aimError: number; // rad std-dev added per shot
  reactionTime: number; // s after acquiring a firing solution
}

export interface EngineAudioSpec {
  baseFreq: number; // fundamental at idle
  diesel: boolean; // diesel clatter vs petrol snarl
}

/** Simplified hit volume for shell impacts. */
export interface HitboxSpec {
  halfW: number;
  halfL: number;
  hullBottomY: number;
  hullTopY: number;
  turretZ: number; // turret axis position on the hull
  turretR: number;
  turretH: number;
}

export interface RingSpec {
  z: number;
  y: number;
  r: number;
}

export interface TankSpec {
  id: 'tiger' | 't34';
  displayName: string;
  mass: number;

  maxForwardSpeed: number;
  maxReverseSpeed: number;
  steerSpeed: number;
  enginePower: number;

  trackCenterX: number;
  trackWidth: number;
  trackThickness: number;
  trackShoe: number;
  trackLinkPitch: number;
  wheelRadius: number;
  wheelAxlesZ: readonly number[];
  hardpointY: number;
  suspensionRest: number;
  suspensionTravel: number;
  springK: number;
  springC: number;

  driveGain: number;
  maxTraction: number;
  lateralGain: number;
  maxLateral: number;
  brakeTraction: number;

  sprocket: RingSpec; // drive sprocket (front on Tiger, rear on T-34)
  idler: RingSpec;

  originHeight: number;
  hullBottomY: number;
  hullTopY: number;
  turretRingZ: number;

  gun: GunSpec;
  armor: ArmorSpec;
  hp: number;
  ai: AISpec;
  engineAudio: EngineAudioSpec;
  hitbox: HitboxSpec;
  camoScheme: 'german' | 'soviet';
}

/* ========================================================================= */
/* Pz.Kpfw. VI Tiger I Ausf. E (late production)                             */
/* ========================================================================= */

export const TIGER: TankSpec = {
  id: 'tiger',
  displayName: 'Tiger I',
  mass: 57000,

  maxForwardSpeed: 11.3, // ~40 km/h governed
  maxReverseSpeed: 4.4,
  steerSpeed: 1.55,
  enginePower: 300_000, // W at the tracks (HL230 minus losses)

  trackCenterX: 1.49,
  trackWidth: 0.725,
  trackThickness: 0.09,
  trackShoe: 0.07,
  trackLinkPitch: 0.13,
  wheelRadius: 0.4, // Ø 800 mm
  wheelAxlesZ: [2.31, 1.65, 0.99, 0.33, -0.33, -0.99, -1.65, -2.31],
  hardpointY: -0.4,
  suspensionRest: 0.5,
  suspensionTravel: 0.35,
  springK: 350_000,
  springC: 42_000,

  driveGain: 26_000,
  maxTraction: 20_000,
  lateralGain: 42_000,
  maxLateral: 19_000,
  brakeTraction: 30_000,

  sprocket: { z: 2.92, y: -0.62, r: 0.42 }, // front drive
  idler: { z: -2.98, y: -0.7, r: 0.34 },

  originHeight: 1.2,
  hullBottomY: -0.73,
  hullTopY: 0.63,
  turretRingZ: -0.25,

  gun: {
    label: '8.8cm KwK 36 L/56 — PzGr.39',
    elevationMax: (15 * Math.PI) / 180,
    depressionMax: (8 * Math.PI) / 180,
    traverseRate: (22 * Math.PI) / 180,
    elevateRate: (14 * Math.PI) / 180,
    muzzleVelocity: 340,
    reloadTime: 4.8,
    ammo: 40,
    recoilDistance: 0.55,
    recoilImpulse: 34000,
    penetration0: 122, // PzGr.39: ~120 mm @100 m, ~100 @1000 m
    penetrationFalloff: 0.022,
    damage: [260, 430],
    sound: 'kwk36',
  },
  armor: {
    hullFront: 110, // 100 mm vertical + driver plate @9°
    hullSide: 70, // 60–80 mm
    hullRear: 80,
    turretFront: 130, // 100–120 + mantlet overlap
    turretSide: 80,
    turretRear: 80,
    top: 25,
  },
  hp: 1000,
  ai: {
    engageRange: 400,
    preferredRange: 280,
    keepMoving: false, // halts and snipes — German doctrine
    aimError: 0.008,
    reactionTime: 1.6,
  },
  engineAudio: { baseFreq: 42, diesel: false },
  hitbox: {
    halfW: 1.85,
    halfL: 3.16,
    hullBottomY: -0.73,
    hullTopY: 0.63,
    turretZ: -0.25,
    turretR: 1.12,
    turretH: 0.85,
  },
  camoScheme: 'german',
};

/* ========================================================================= */
/* T-34-85 (model 1944, ZiS-S-53)                                            */
/* ========================================================================= */

export const T34: TankSpec = {
  id: 't34',
  displayName: 'T-34-85',
  mass: 32000,

  maxForwardSpeed: 14.7, // 53 km/h
  maxReverseSpeed: 2.1, // single crawling reverse gear
  steerSpeed: 1.7,
  enginePower: 230_000, // V-2-34 500 hp diesel minus losses

  trackCenterX: 1.25, // 3.00 m beam, 500 mm tracks
  trackWidth: 0.5,
  trackThickness: 0.09,
  trackShoe: 0.06,
  trackLinkPitch: 0.172,
  wheelRadius: 0.415, // Ø 830 mm Christie wheels
  wheelAxlesZ: [1.95, 0.95, 0.05, -0.9, -1.8], // 5 axles, gap behind the first
  hardpointY: -0.42,
  suspensionRest: 0.375,
  suspensionTravel: 0.38, // long Christie travel
  springK: 260_000,
  springC: 24_000,

  driveGain: 26_000,
  maxTraction: 16_000,
  lateralGain: 36_000,
  maxLateral: 15_000,
  brakeTraction: 24_000,

  sprocket: { z: -2.62, y: -0.72, r: 0.32 }, // REAR drive sprocket
  idler: { z: 2.62, y: -0.73, r: 0.3 }, // front idler

  originHeight: 1.15,
  hullBottomY: -0.75, // 0.40 m clearance
  hullTopY: 0.4,
  turretRingZ: 0.55, // turret sits forward, engine aft

  gun: {
    label: '85mm ZiS-S-53 — BR-365',
    elevationMax: (22 * Math.PI) / 180,
    depressionMax: (5 * Math.PI) / 180, // poor depression — real weakness
    traverseRate: (26 * Math.PI) / 180, // electric traverse, faster than Tiger
    elevateRate: (16 * Math.PI) / 180,
    muzzleVelocity: 350,
    reloadTime: 6.0,
    ammo: 55,
    recoilDistance: 0.42,
    recoilImpulse: 22000,
    penetration0: 111, // BR-365: ~105 mm @500 m, ~95 @1000 m
    penetrationFalloff: 0.021,
    damage: [220, 380],
    sound: 'zis53',
  },
  armor: {
    hullFront: 90, // 45 mm @ 60°
    hullSide: 56, // 40–45 mm @ ~40° upper
    hullRear: 58, // 45 mm @ ~47°
    turretFront: 95, // 90 mm cast + mantlet
    turretSide: 75,
    turretRear: 60,
    top: 20,
  },
  hp: 800,
  ai: {
    engageRange: 330,
    preferredRange: 140, // must close where the 85 mm penetrates
    keepMoving: true, // circles and fires on the move — Soviet practice
    aimError: 0.01,
    reactionTime: 1.7,
  },
  engineAudio: { baseFreq: 30, diesel: true },
  hitbox: {
    halfW: 1.5,
    halfL: 3.05,
    hullBottomY: -0.75,
    hullTopY: 0.4,
    turretZ: 0.55,
    turretR: 1.05,
    turretH: 0.75,
  },
  camoScheme: 'soviet',
};

export const SPECS: Record<'tiger' | 't34', TankSpec> = { tiger: TIGER, t34: T34 };
