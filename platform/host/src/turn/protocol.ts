// Wire protocol between client and room. Every inbound message is parsed here, strictly, before anything else sees it.
import { isToken } from './crypto.ts';

export interface ProfileAuth { id: string; secret: string }

export type HostCmd =
  | { c: 'approve'; request: string; seat?: string }
  | { c: 'reject'; request: string }
  | { c: 'kick'; seat: string }
  | { c: 'settings'; settings: unknown; bots: number }
  | { c: 'start' }
  | { c: 'rotate_invite' }
  | { c: 'lock'; on: boolean }
  | { c: 'turn_timer'; seconds: number }
  | { c: 'bot_speed'; x: number }
  | { c: 'bot_seat'; seat: string; on: boolean }
  | { c: 'close' };

export type C2S =
  | { t: 'join'; name: string; invite: string; token: string; profile?: ProfileAuth }
  | { t: 'resume'; token: string; profile?: ProfileAuth }
  | { t: 'action'; type: string; params: unknown }
  | { t: 'autopilot'; on: boolean }
  | { t: 'profile_create' }
  | { t: 'profile_link'; profile: ProfileAuth }
  | { t: 'profile_delete'; profile: ProfileAuth }
  | { t: 'profile_stats' }
  | { t: 'host'; cmd: HostCmd };

export interface SeatPublic {
  id: string; name: string; isHost: boolean; connected: boolean; bot: 'none' | 'ai' | 'self' | 'afk' | 'host'; hasProfile: boolean;
}
export interface PendingPublic { id: string; name: string; dupName: boolean; ageMs: number }
export interface Stats { games: number; wins: number; totalScore: number; extras: Record<string, number> }

export type S2C =
  | { t: 'pending'; position: number }
  | { t: 'joined'; seat: string; host: boolean }
  | { t: 'rejected' }
  | { t: 'kicked' }
  | { t: 'replaced' }
  | { t: 'lobby'; phase: 'lobby' | 'playing' | 'finished'; seats: SeatPublic[]; settings: unknown; maxPlayers: number; minPlayers: number;
      bots: number; locked: boolean; inviteExpiresAt: number; turnTimerS: number; botSpeed: number; usage: { fraction: number; warn: boolean };
      pending?: PendingPublic[] }
  | { t: 'invite'; secret: string; expiresAt: number }
  | { t: 'state'; view: unknown; events: unknown[]; cfg?: unknown; deadlines: Record<string, number>; now: number;
      autopilot: boolean; thinking: string | null; turnDeadline: number | null }
  | { t: 'profile'; id: string; name: string; secret?: string; recovery?: string; stats: Stats | null }
  | { t: 'error'; code: string; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseProfile(v: unknown): ProfileAuth | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v) || typeof v.id !== 'string' || !/^[0-9a-f]{16}$/.test(v.id) || !isToken(v.secret)) return null;
  return { id: v.id, secret: v.secret };
}

function parseHost(v: unknown): HostCmd | null {
  if (!isObj(v) || typeof v.c !== 'string') return null;
  const id = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(x);
  switch (v.c) {
    case 'approve': return id(v.request) && (v.seat === undefined || id(v.seat)) ? { c: 'approve', request: v.request, seat: v.seat as string | undefined } : null;
    case 'reject': return id(v.request) ? { c: 'reject', request: v.request } : null;
    case 'kick': return id(v.seat) ? { c: 'kick', seat: v.seat } : null;
    case 'settings': return typeof v.bots === 'number' && Number.isInteger(v.bots) && v.bots >= 0 && v.bots <= 8 ? { c: 'settings', settings: v.settings, bots: v.bots } : null;
    case 'start': return { c: 'start' };
    case 'rotate_invite': return { c: 'rotate_invite' };
    case 'lock': return typeof v.on === 'boolean' ? { c: 'lock', on: v.on } : null;
    case 'turn_timer': return typeof v.seconds === 'number' && Number.isInteger(v.seconds) && v.seconds >= 0 && v.seconds <= 3600 ? { c: 'turn_timer', seconds: v.seconds } : null;
    case 'bot_speed': return typeof v.x === 'number' && (v.x === 0 || (v.x >= 0.25 && v.x <= 16)) ? { c: 'bot_speed', x: v.x } : null;
    case 'bot_seat': return id(v.seat) && typeof v.on === 'boolean' ? { c: 'bot_seat', seat: v.seat, on: v.on } : null;
    case 'close': return { c: 'close' };
    default: return null;
  }
}

/** Strict parse of one raw client message. Unknown types and extra shapes are rejected (null). */
export function parseC2S(raw: string): C2S | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'join': {
      const profile = parseProfile(v.profile);
      if (profile === null || typeof v.name !== 'string' || !isToken(v.invite) || !isToken(v.token)) return null;
      return { t: 'join', name: v.name, invite: v.invite, token: v.token, ...(profile ? { profile } : {}) };
    }
    case 'resume': {
      const profile = parseProfile(v.profile);
      if (profile === null || !isToken(v.token)) return null;
      return { t: 'resume', token: v.token, ...(profile ? { profile } : {}) };
    }
    case 'action':
      return typeof v.type === 'string' && v.type.length <= 32 ? { t: 'action', type: v.type, params: v.params ?? {} } : null;
    case 'autopilot': return typeof v.on === 'boolean' ? { t: 'autopilot', on: v.on } : null;
    case 'profile_create': return { t: 'profile_create' };
    case 'profile_link': { const p = parseProfile(v.profile); return p ? { t: 'profile_link', profile: p } : null; }
    case 'profile_delete': { const p = parseProfile(v.profile); return p ? { t: 'profile_delete', profile: p } : null; }
    case 'profile_stats': return { t: 'profile_stats' };
    case 'host': { const cmd = parseHost(v.cmd); return cmd ? { t: 'host', cmd } : null; }
    default: return null;
  }
}
