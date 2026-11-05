// Only WebCrypto: no dependencies. Used by both the Worker and the room.

const enc = new TextEncoder();
const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** 128-bit random capability (seat token, invite secret, profile secret). */
export const newToken = (): string => randomHex(16);
export const isToken = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

/** Constant-time string comparison (both sides hashed to equal length first). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0 && ha.length === hb.length;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try { return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0)); } catch { return null; }
}

/** Room capability = "<roomId>.<mac>". The mac lets the Worker reject forged room ids without touching a Durable Object. */
export async function signRoomId(hostKey: string, roomId: string): Promise<string> {
  const key = await hmacKey(`room-cap-v1:${hostKey}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(roomId))).slice(0, 16);
  return `${roomId}.${b64url(mac)}`;
}

/** Returns the room id if the capability is genuine, else null. Uses HMAC verify (constant time). */
export async function verifyRoomCap(hostKey: string, cap: string): Promise<string | null> {
  const dot = cap.indexOf('.');
  if (dot < 1 || cap.length > 120) return null;
  const roomId = cap.slice(0, dot);
  if (!/^[0-9a-f]{32}$/.test(roomId)) return null;
  const mac = unb64url(cap.slice(dot + 1));
  if (!mac || mac.length !== 16) return null;
  const key = await hmacKey(`room-cap-v1:${hostKey}`);
  const full = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(roomId)));
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= full[i]! ^ mac[i]!;
  return diff === 0 ? roomId : null;
}

/** Display names are plain text only: strip control, bidi and zero-width characters, collapse spaces, cap length. */
export function sanitizeName(raw: unknown, maxLen: number, fallback = 'Player'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim();
  return cleaned || fallback;
}
