/**
 * `@app-builder/host/turn`: turn-based rooms that friends join through invite
 * links, with no login. An invite-mode app's Worker entry is:
 *
 *   import { registerTurn, inviteWorker } from '@app-builder/host/turn';
 *   import { myGame } from '../src/game';
 *   registerTurn([myGame], { host: config.host });
 *   export { TurnRoom, ProfileStore } from '@app-builder/host/turn';
 *   export default inviteWorker;
 *
 * Pure parts (room logic, crypto, protocol) import nothing from Cloudflare, so
 * apps test them directly in Node or Vitest (`@app-builder/host/turn/testing`
 * runs a room in memory).
 */
export { registerTurn, turnGame, defaultTurnGame, turnBasePath } from './registry.ts';
export { default as inviteWorker, routeInvite } from './worker.ts';
export { TurnRoom } from './room.ts';
export { ProfileStore } from './profiles.ts';
export { RoomCore, Out, type RoomDeps, type Seat, type ConnAttachment } from './room_core.ts';
export { configureTurn, turnConfig, HOST_CONFIG as TURN_CONFIG, type HostConfig as TurnConfig, type TurnOverrides } from './config.ts';
export { defineGame, type ErasedGame, type GameInstance, type GameModule, type GameResult, type SeatInfo } from './game.ts';
export type * from './protocol.ts';
export type { TurnEnv } from './env.ts';
