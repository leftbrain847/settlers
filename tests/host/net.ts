// The platform's in-memory room harness, bound to Settlers.
import { Net as PlatformNet } from '@app-builder/host/turn/testing';
import type { HostConfig } from '@app-builder/host/turn/config';
import type { ProfilesCore } from '@app-builder/host/turn/profiles_core';
import { settlersModule } from '../../games/settlers/game.ts';

export { Client, LoopbackSocket } from '@app-builder/host/turn/testing';
export type Net = PlatformNet;
export const Net = { make: (host?: HostConfig, profiles?: ProfilesCore): Promise<PlatformNet> => PlatformNet.make(settlersModule, host, profiles) };
