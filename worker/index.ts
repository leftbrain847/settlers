/**
 * Settlers' Worker (invite mode): friends join by link, no login. Registers the game, then hands every request to
 * the platform's invite host (host key, signed room links, approvals, rooms). Secret: `wrangler secret put HOST_KEY`.
 */
import { inviteWorker, registerTurn } from '@app-builder/host/turn';
import config from '../app.config.json' with { type: 'json' };
import { settlersModule } from '../games/settlers/game.ts';

registerTurn([settlersModule], { host: config.host });

export { ProfileStore, TurnRoom } from '@app-builder/host/turn';
export default inviteWorker;
