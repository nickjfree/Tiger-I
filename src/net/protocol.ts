/* ---------------------------------------------------------------------------
 * Wire protocol shared by client and server. Plain JSON messages.
 *
 * Movement is client-authoritative (each client simulates only its own tank
 * and streams its transform); damage/HP/kills/respawns are server-
 * authoritative; the AI tank is simulated entirely on the server.
 * ------------------------------------------------------------------------ */

import type { HitFacet } from '../sim/hittest';

export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 8;
export const SNAPSHOT_HZ = 20;
export const CLIENT_STATE_HZ = 20;
/** Remote tanks render this far in the past to interpolate between snapshots. */
export const INTERP_DELAY_MS = 130;
/** Long enough to watch the full ammunition cook-off (~8.5 s) burn out. */
export const RESPAWN_SECONDS = 12;
export const AI_RESPAWN_SECONDS = 15;

export type TankId = 'tiger' | 't34';

/** Per-entity state carried in snapshots (also used for roster seeding). */
export interface EntityState {
  id: string;
  p: [number, number, number];
  q: [number, number, number, number];
  ty: number; // turret yaw (hull-local)
  gp: number; // gun pitch
  vl: number; // left track ground speed
  vr: number; // right track ground speed
  mg: number; // bit 1 = coax firing, bit 2 = hull MG firing
}

export interface RosterEntry {
  id: string;
  name: string;
  tank: TankId;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  ai: boolean;
  state: EntityState;
}

export interface PropEvent {
  kind: 'tree' | 'fence' | 'shed';
  index: number;
  dx: number;
  dz: number;
}

/* ---- client → server ---- */

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; tank: TankId }
  | ({ t: 'st' } & Omit<EntityState, 'id'>)
  | { t: 'fire'; p: [number, number, number]; d: [number, number, number]; mv: number }
  | { t: 'claim'; target: string; facet: HitFacet; dist: number; point: [number, number, number] }
  | ({ t: 'prop' } & PropEvent)
  | { t: 'ping'; c: number };

/* ---- server → client ---- */

export type ServerMsg =
  | { t: 'full' }
  | {
      t: 'welcome';
      id: string;
      time: number;
      roster: RosterEntry[];
      props: PropEvent[];
      spawn: { x: number; z: number; yaw: number };
    }
  | { t: 'join'; entry: RosterEntry }
  | { t: 'leave'; id: string; name: string }
  | { t: 'snap'; time: number; s: EntityState[] }
  | { t: 'fire'; id: string; p: [number, number, number]; d: [number, number, number]; mv: number }
  | {
      t: 'hit';
      target: string;
      by: string;
      facet: HitFacet;
      pen: boolean;
      damage: number;
      hp: number;
      killed: boolean;
      point: [number, number, number];
    }
  | { t: 'spawn'; id: string; x: number; z: number; yaw: number; hp: number }
  | { t: 'kill'; by: string; byName: string; victim: string; victimName: string }
  | { t: 'scores'; s: Array<{ id: string; kills: number; deaths: number }> }
  | ({ t: 'prop' } & PropEvent)
  | { t: 'pong'; c: number; s: number };

export function vec3(v: { x: number; y: number; z: number }): [number, number, number] {
  return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
}

export function quat(q: { x: number; y: number; z: number; w: number }): [number, number, number, number] {
  return [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4)];
}
