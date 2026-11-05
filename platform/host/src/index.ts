/**
 * `@app-builder/host`: everything an app's Worker needs. An app's entry file is:
 *
 *   import { register, worker } from '@app-builder/host';
 *   import { app } from '../src/module';
 *   register([app]);
 *   export { GameRoom, SoloRun } from '@app-builder/host';
 *   export default worker;
 *
 * The shared `UsageMeter` and `Scores` objects live in the platform Worker
 * (`platform.ts`); apps bind to them by `script_name`.
 */
export { register, gameById, site, type AnyApp, type AppSite } from './registry';
export { default as worker } from './worker';
export { GameRoom } from './room';
export { SoloRun, Scores } from './solo';
export { UsageMeter } from './usage';
export { RoomCore, type Outgoing, type RoomSnapshot } from './roomCore';
export { configureHost, hostConfig, HOST_CONFIG, type HostConfig, type HostOverrides } from './config';
export type { GameLimits, GameModule, PlayerId, SoloVerifier } from './gameModule';
export type * from './protocol';
