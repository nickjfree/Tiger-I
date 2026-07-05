/* ---------------------------------------------------------------------------
 * Shared Tiger I dimensions & tuning constants.
 *
 * Real Tiger I (late production) reference values:
 *   hull length 6.316 m · width 3.705 m · height ~3.0 m · mass ~57 t
 *   track width 725 mm · track pitch 130 mm · road wheel Ø 800 mm
 *   8 interleaved road-wheel axles per side · front drive sprocket, rear idler
 *   8.8 cm KwK 36 L/56 · elevation −8°/+15° · ~92 shells carried
 *
 * All model/physics/track modules read from this single table so the visual
 * mesh, the suspension and the track path always agree with each other.
 * Coordinate convention: +Z is the tank's forward axis, +Y up, origin at the
 * hull center sitting `originHeight` above flat ground at rest.
 * ------------------------------------------------------------------------ */

export const TIGER = {
  /* --- mass & drivetrain ------------------------------------------------ */
  mass: 57000, // kg
  maxForwardSpeed: 11.3, // m/s  (~40 km/h, late-production governed)
  maxReverseSpeed: 4.4, // m/s
  /** Extra differential track speed commanded by full steering input (m/s). */
  steerSpeed: 1.55,

  /* --- suspension geometry (torsion bar → modeled as vertical springs) --- */
  trackCenterX: 1.49, // lateral distance hull center → track centerline
  trackWidth: 0.725,
  trackThickness: 0.09, // visual link plate + horn envelope
  wheelRadius: 0.4, // 800 mm road wheels
  /** Road wheel axle Z positions, front → rear. */
  wheelAxlesZ: [2.31, 1.65, 0.99, 0.33, -0.33, -0.99, -1.65, -2.31],
  hardpointY: -0.4, // suspension attachment height (local Y)
  suspensionRest: 0.5, // rest extension below hardpoint (to wheel center)
  /** The wheel rides ON the track, so ground contact happens one track-shoe
   *  below the wheel rim. Without this the links visually sink into the
   *  terrain. */
  trackShoe: 0.07,
  suspensionTravel: 0.35, // max compression before bump stop
  springK: 350_000, // N/m per wheel station
  springC: 42_000, // N·s/m per wheel station

  /* --- traction --------------------------------------------------------- */
  driveGain: 26_000, // N per (m/s) of track-speed error, per station
  maxTraction: 20_000, // longitudinal force clamp per station (N) → ~320 kN crawl
  /** Power actually delivered to the tracks (Maybach HL230 ≈ 700 PS gross,
   *  minus transmission losses). Caps drive force at speed so the 57 t hull
   *  accelerates like a tank, not a sports car. */
  enginePower: 300_000, // W
  lateralGain: 42_000, // N per (m/s) lateral slip, per station
  maxLateral: 19_000, // lateral force clamp per station (N)
  brakeTraction: 30_000, // longitudinal clamp when handbraking

  /* --- running gear ------------------------------------------------------ */
  sprocket: { z: 2.92, y: -0.62, r: 0.42 }, // front drive sprocket
  idler: { z: -2.98, y: -0.7, r: 0.34 }, // rear idler
  trackLinkPitch: 0.13, // 130 mm Kgs 63/725/130 track pitch

  /* --- reference heights -------------------------------------------------- */
  originHeight: 1.2, // hull-center origin above ground at static rest
  hullBottomY: -0.73, // belly (0.47 m ground clearance at rest)
  hullTopY: 0.63, // superstructure deck

  /* --- armament ----------------------------------------------------------- */
  gun: {
    elevationMax: (15 * Math.PI) / 180,
    depressionMax: (8 * Math.PI) / 180,
    /** Turret hydraulic traverse (rad/s). Historical ≈ 6°/s at max rpm —
     *  raised here for playability while keeping the "heavy" feel. */
    traverseRate: (22 * Math.PI) / 180,
    elevateRate: (14 * Math.PI) / 180,
    muzzleVelocity: 340, // m/s — scaled down from 773 so arcs read at map scale
    reloadTime: 4.8, // s
    ammo: 40,
    recoilDistance: 0.55,
  },
  turretRingZ: -0.25, // turret center position on hull
} as const;
