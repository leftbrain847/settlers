# App platform

## For J (the short version)

One pipeline builds every app. Each app ships to up to two places from one codebase:

| Target | Who | Where | Login | Cost |
| --- | --- | --- | --- | --- |
| **Friends** | Up to 50 friends, on iPhone, Android or PC | `apps.<domain>/<app>/` in the browser | Cloudflare Access email code, once for all apps | ~$10.46/yr domain; $5/mo Workers Paid only if friends outgrow the free pool |
| **Friends, by link** (`invite` apps) | Anyone you send a link to, approved by you | `play.<domain>/<app>/` in the browser | None: an unguessable invite link, and you let each person in | Same as Friends |
| **Google Play** | Anyone | Android app, bundled, offline | None | $25 once for the Play account |

- **Play v1 is single-player only.** Online play for strangers needs accounts, moderation and paid hosting; parked until an app earns it.
- **No App Store.** iPhone friends use the browser link.
- **Each app has its own repo and its own Worker,** so one bad deploy can't break the others.
- **Apps carry a stamped copy of the platform** in `platform/`. `sync` refreshes it, one commit per bump, so a platform change reaches an app only when you say so.

One-time setup is in `README.md`. Per Play app, you recruit 12 testers for 14 days before its first public release.

---

## For Claude Code (the full spec)

Read all of this before changing the platform or an app's platform-facing parts. Precedence: J's instructions, then this file, then your defaults.

**Verify before you rely.** External facts marked *(verify)* come from docs read in October 2026. Fetch the current official page before building on one, and update this file if it changed.

### 1. Status (keep this table current)

| Piece | State |
| --- | --- |
| Host library: Access check, routing at `/<id>/`, solo replay, rooms, rate limits, headers | Built; unit-tested here |
| Turn-based rooms (`tickHz: 0`): no timers, state saved per move, restored after hibernation | Built; core unit-tested. Hibernation itself only happens on Cloudflare: **not yet tested live** |
| Real-time rooms (`tickHz > 0`) | Built (from RedZone); the template has no real-time sample yet |
| Platform Worker: shared `UsageMeter` and `Scores`, index page | Built; unit-tested; dry-run deploy passes |
| Cross-Worker Durable Object bindings (`script_name`) on the free plan | Dry-run accepts them. **Not yet verified on a real deploy** *(verify)* |
| One Access login covering every `/<id>/` path | **Not yet verified live** *(verify with two apps before scaling)* |
| Invite mode: turn rooms joined by link, no login (host key, signed room links, host approval, bots, turn timers, hidden info, profiles) | Built (lifted from Settlers' own host, where it ran its tests and e2e); unit-tested here. **Not yet deployed live** |
| Template: solo, turn and invite samples, tests, builds | Built; CI generates all three and runs their checks |
| Sprint demo (`npm run build:demo`, `npm run snapshot`): the app as one self-contained page, no server | Built for solo and invite apps; CI builds both. Turn apps have none (rooms need Access) |
| `create-app`, `sync`, `platform-config` scripts | Built; exercised by CI |
| App CI: test, deploy, smoke, auto-rollback | Written. The smoke test is checked locally against a fake walled server (passes) and a fake open one (fails). **Not yet run against a live deploy** |
| Android build + Play internal-track upload | Written; **untested** (Capacitor 8.5.3, `r0adkll/upload-google-play@v1`) *(verify)* |
| Protocol version handshake (old cached clients vs a new server) | **Not built** |
| Usage meter across Workers | Built as one shared object; tallies are per isolate and approximate |

### 2. Layout

**`app_builder` (this repo)** — npm workspaces, exact pins, `npm ci` only.

```
packages/host/            Worker library + the platform Worker (src/platform.ts, wrangler.platform.toml)
packages/client-sdk/      browser side: API calls, room socket with reconnect, interpolation
template/                 what create-app copies; samples/ holds one rules file, client and test per mode
scripts/create-app.mjs    new app from the template
scripts/sync-platform.mjs refresh an app's platform/ copy
scripts/platform-config.mjs  regenerate the platform Worker's wrangler config
scripts/lib.mjs           shared by the three scripts (renders every wrangler.toml)
platform.config.json      account-wide settings: hostname, zone, account id, Access team and AUD, allowed emails
apps.json                 the apps the index page lists
skills/ship-app/          the skill J uploads to claude.ai
SPEC.md                   this file (copied into every app as platform/SPEC.md)
```

**An app repo** (made by `create-app`):

```
app.config.json      id, title, mode, host overrides, targets: the app's settings
src/app.ts           the rules: a GameModule
src/client/          UI: main.ts, ui.ts (DOM helpers, text only), styles.css (theme tokens), demo.ts (sprint demo entry)
demo/                the sprint demo build: one self-contained page (solo and invite apps)
snapshots/           committed day snapshots, `YYYY-MM-DD - <Title>.html` (frozen records; the index repo finds them)
test/app.test.ts     vitest
worker/index.ts      registers the module with the host; nothing else
platform/            GENERATED: host + SDK source, SPEC.md, platform.config.json, VERSION.json
wrangler.toml        GENERATED from app.config.json + platform.config.json
.github/workflows/app.yml, scripts/smoke.mjs, scripts/check-play-bundle.mjs   GENERATED
CLAUDE.md            this app's own decisions only
```

Apps depend on `@app-builder/host` and `@app-builder/client-sdk` through `file:platform/...`. No registry, no cross-repo auth: an app builds from its own repo alone. The sync rewrites the SDK's dependency on the host to `file:../host`, so nothing ever resolves `@app-builder/*` from the public npm registry.

### 3. Settings are config

- **`platform.config.json`** holds what every app shares. None of it is secret: the Access team name and AUD tag appear in every login token. `allowedEmails` is the immediate-revocation list (see Operations).
- **`app.config.json`** holds one app's settings. `host` overrides any `HostConfig` value for that app's Worker (for example, `emptyRoomTtlMs`: 5 minutes by default, 7 days for turn apps so a game survives overnight).
- **Rules** live in typed config objects in `src/app.ts` with documented defaults. No magic numbers in logic.

### 4. Friends target (Cloudflare)

**Request flow:**
1. The browser hits Cloudflare Access on `apps.<domain>`.
2. Access passes the request to the app's Worker on routes `apps.<domain>/<id>` and `apps.<domain>/<id>/*`.
3. The Worker re-verifies the Access JWT (fail closed, 403 with no body).
4. It strips `/<id>`, then serves the client from static assets or routes `/api/...` to its Durable Objects.

The platform Worker owns `/`, `/index.html` and `/api/platform/*`. More specific routes win *(verify)*.

**Access:**
- One self-hosted application on the hostname `apps.<domain>`, covering every path.
- Never the Worker-level "Protect this Worker" toggle: it rejects WebSocket upgrades *(verify)*.
- Every Worker has `workers_dev = false`, `preview_urls = false`, and only the routes above.

**Auth (in the host):**
- Every request, static files included (`run_worker_first = true`), needs a `Cf-Access-Jwt-Assertion` token.
- It must be RS256-signed by a current team key, matched by `kid`. Keys are cached for an hour; an unknown `kid` refetches at most once a minute.
- It must carry the right `aud` and `iss`, valid `exp`/`iat`/`nbf`, and an email.
- If `allowedEmails` is non-empty, the email must be on it.
- Missing config denies everything.
- The Worker sets `X-Verified-Player` itself; Durable Objects have no public route.
- Every response carries the CSP `'self'`, `nosniff`, `no-referrer` and `frame-ancestors 'none'`.

**Shared state:**
- `USAGE` and `SCORES` are bound with `script_name = "app-platform"`, so every app counts into one meter and posts to one set of boards.
- The free limits are per account, which is why the meter is shared. Workers allow 100,000 requests a day at 10 ms CPU each.
- Durable Object limits:
  - 100,000 requests a day
  - 13,000 GB-s of run time a day
  - 100,000 rows written a day
  - inbound WebSocket messages billed 20:1
  - SQLite-backed classes only
- Limits reset at 00:00 UTC (7 pm Eastern in winter) *(verify)*.
- The meter warns at 70% and refuses new runs and rooms at 95%. Play already in progress continues.

**Modes:**
1. **`solo`.** Plays in the browser.
    - When the host is reachable, the server issues the seed and the `SoloRun` object replays each submitted segment.
    - Only server-computed scores are recorded.
    - If the host can't be reached, the run continues unranked.
    - Cost: about 2 requests per segment.
2. **`turn`** (`tickHz: 0`). Server-authoritative, with no `setInterval` or `setTimeout`, so the room can hibernate between moves and bill no run time *(verify: timers and alarms prevent hibernation)*.
    - After each move that changes the state, the room saves a snapshot and sends every connected player their own view. Ignored moves (out of turn) and pings cost no write and no broadcast, and pings count against the rate limit.
    - On wake it restores the snapshot and re-attaches the surviving sockets.
    - Cost: 1 request to join, plus 1 per 20 moves.
3. **`room`** (`tickHz > 0`, real-time). Server-authoritative fixed-step loop while anyone is connected.
    - Cost: each player sending inputs counts 1/20 of a request per message.
    - Example: 4 players × 20 inputs/s is 4 requests/s, about 7 hours of play a day from the free pool.
    - Send inputs only when they change (`InputOnChange`).

4. **`invite`** (turn-based, no login). For playing with friends who shouldn't need an account. Lives on `friendsHost` (`play.<domain>`), which **must not** be behind Access; the app's own Worker (`platform/host/src/turn/`) is the only gate:
    - Only the owner creates rooms, with the `HOST_KEY` Wrangler secret (constant-time compare). No key, or one under 32 characters, refuses everything.
    - A room link is the room id plus an HMAC under the host key, so a forged or guessed id is refused before any Durable Object runs. A WebSocket from another site's page is refused (`Origin`).
    - Joining needs the 128-bit invite secret, carried in the link's `#fragment` (never sent in a URL or logged), and then the host's approval. Invites expire (`inviteTtlMs`) and can be rotated or locked. Each device keeps a random seat token; the room stores only hashes.
    - The richer turn contract (`TurnGame`): `parseAction`, `reduce` with events, `viewFor` plus `redactEvents` for hidden information, timers, bot seats with pacing and human↔bot handoff, a turn timer that hands a missing player to a bot, lobby settings parsed and clamped by the game, results recorded to optional profiles.
    - Timers and bots run on the Durable Object alarm, never `setTimeout`, so the room still hibernates between moves.
    - Rooms count into the shared `USAGE` meter. Idle lobbies, idle games and finished games delete themselves (`lobbyIdleTtlMs`, `gameIdleTtlMs`, `finishedRoomTtlMs`).
    - Test a game in a real room in memory with `@app-builder/host/turn/testing` (no Cloudflare needed).
    - Sockets that don't authenticate within `authTimeoutMs` are dropped; a room takes at most `maxConnections` sockets; handing a seat to a newcomer disconnects whoever held it; a bot whose moves keep failing pauses after `maxBotFailures` turns.
    - Every Worker request, refusals included, counts into the shared meter.
    - **Known limits (accepted for now):** the open hostname is reachable by anyone, so a request flood can spend the account's free daily quota (no data exposed, but every app stops until 00:00 UTC). The guard is a Cloudflare rate-limiting rule on `friendsHost` (one-time setup, below). A room link can't be revoked short of closing the room (rotating the invite stops new joins). Anyone holding an invite can fill the 8-slot join queue until the host rotates or locks it. All invite apps share one origin, so their browser storage is shared.
    - Not supported in invite mode: real-time rooms and solo replay (they assume Access identities).

**Every room, any mode:**
- Seats bind to the verified email; a reconnect within `seatGraceMs` reclaims the seat.
- Oversized messages are dropped before parsing.
- Each message is checked for the `{t, s, d}` envelope, then the app's `parseInput`, then the per-player rate limit. Sustained flooding closes the socket.
- Each player gets only `viewFor(state, them)`.
- A room deletes itself after `emptyRoomTtlMs` empty.

### 5. Google Play target

**v1 scope.** Single-player and fully offline:
- No login, no network calls, no analytics, no ads, no billing.
- `create-app` turns Play on only for `solo` apps.
- `targets.play.multiplayer` must stay `false`.

**Packaging.**
- Capacitor, with the client bundled into the app, not a Trusted Web Activity. The Play build never touches the Access-gated host and needs no `assetlinks.json` exception.
- `VITE_TARGET=play` compiles out every network path.
- `scripts/check-play-bundle.mjs` fails the build if the bundle contains `fetch(`, `WebSocket`, `/api/`, `XMLHttpRequest`, `sendBeacon` or `EventSource`.

**Release.**
- A `vX.Y.Z` tag builds a signed AAB and uploads it to the **internal** track. `versionCode` comes from the CI run number and `versionName` from the tag.
- Promotion to closed or production is manual in the Play Console. Never automate it.

**Store requirements.** Before the first upload, fetch the current Play Console help pages and record the answers in this file *(verify each)*:
- the target API level
- AAB format
- a privacy policy URL; host a static page outside Access (not built yet)
- the Data safety form; v1 answer: no data collected
- the content rating questionnaire
- store listing assets: icon 512×512, feature graphic, screenshots
- the closed-test rule: new personal accounts need ≥12 testers opted in for 14 consecutive days before production. Record whether it applies per app or per account.

### 6. iOS

Friends only, via the browser link. A home-screen shortcut keeps its own cookies, so friends log in once more there *(verify on a current iOS device)*. No App Store work unless J asks.

### 7. CI/CD

**App repos (`.github/workflows/app.yml`, generated):**
1. **`test`**, on every push and PR: typecheck, tests, build, and the Play no-network check when Play is on.
2. **`deploy-friends`**, on `main`: `wrangler deploy`. Skipped (green, with a notice in the run summary) until the app's host (`friendsHost` for invite apps, `appsHost` otherwise) is no longer an `*.example.com` placeholder and `CLOUDFLARE_API_TOKEN` is set.
    - Then the smoke test: unauthenticated requests to the page, assets, API and room socket must all hit the login wall, and the config must show no `workers.dev` or preview URLs.
    - The smoke test also runs if the deploy step failed partway, since wrangler may already have published.
    - If the smoke test fails: `wrangler rollback -y`.
3. **`android`**, on a `v*` tag when Play is on: build, sign, upload to the internal track.

**Secrets, set per app repo:**
- Always: `CLOUDFLARE_API_TOKEN`, with the narrowest Workers permissions Cloudflare offers *(verify; tokens may not scope to one Worker)*.
- Play only: `PLAY_SERVICE_ACCOUNT_JSON`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- The Cloudflare account id is read from `platform.config.json`.

**app_builder (`.github/workflows/ci.yml`):**
- Runs the platform's tests.
- Generates a solo, a turn and an invite app from the template and puts each through install, typecheck, tests, build and a dry-run deploy, plus the Play bundle check. For solo and invite it also builds the sprint demo, which fails on any network code or any file the page would need beside it.
- Deploys the platform Worker on `main` once `platform.config.json` is filled in and the token secret exists.

**Dev never spends the shared pool.** Use `npm run dev` (UI only), `npm run worker:dev` (`wrangler dev`, local) and vitest. No staging Worker on the production account.

### 8. Adding an app (one sprint day)

A new app is normally one day of J's sprint. **The day ships when its demo page is published and committed**, not when Cloudflare deploys; the live friends link comes later, once the secrets exist.

1. **Setup (J).** Create an empty GitHub repo. Start a session with it, `app_builder` and `index` attached, and type `/ship-app <id>: <what to build>` (or attach a brief).
2. **Generate.** Pick the mode: `solo` for single-player, `invite` for anything multiplayer (it plays in the demo page against bots), `turn` only if J asks (it needs Access and has no demo). Run `node scripts/create-app.mjs <id> --mode <mode> --title "<Title>" --out <app repo clone>`, then `npm install` there and commit `package-lock.json` (CI uses `npm ci`).
3. **Build.** Write the rules in `src/app.ts`, the UI in `src/client/` and tests in `test/`, keeping the sample's shape. `npm run typecheck && npm test && npm run build && npm run build:demo` must pass.
4. **Play-test it like a person.** Open `dist/demo/page.html` at phone width (390 px) in Chromium, play several full turns, and look at the screenshots. Everything a player needs (whose turn it is, what was rolled or drawn, what just moved, the result) must stay on screen long enough to read. Check there's no horizontal overflow at 360 px. Fix what you find before publishing.
5. **Write the demo clip.** Edit `demo/clip.json`: the script the index uses to record the app's homepage clip, a 4–9 s dark-mode video that plays once on hover and holds its last frame. It must show the app's core function within the first 1–2 seconds (the move, the answer, the result), with no intro or menus. Steps before `{"start": true}` set the scene and aren't shown; then a few `tap`/`type`/`wait` steps do the core thing. `selector` is the part of the page to show. `npm run build:demo` checks the format.
6. **Publish the day's artifact.** Publish `dist/demo/page.html` as a Claude artifact. Its title is already `YYYY-MM-DD - <Title>`, dated in `app.config.json` → `sprint.timeZone`. Republish the same artifact for fixes during the day; once the day is over, it's a frozen record.
7. **Snapshot and PRs.** Run `npm run snapshot` and commit `snapshots/YYYY-MM-DD - <Title>.html` with the app, then open the app's PR. In a separate app_builder PR, add `{ "id": "<id>", "title": "<Title>" }` to `apps.json`. No index edit is needed: its nightly refresh finds the snapshot on the app's default branch.
8. **Report.** Give the artifact link, the PRs J has to merge, and the public sprint site (`https://<owner>.github.io/<index.yml config.site.repo>/`). After J merges, the index's nightly refresh (1:47 AM ET) lists the day. It publishes the day on the public site only if the page carries the `sprint-public` tag (`sprint.public` in `app.config.json`) and passes UAT and the secret scan. To publish sooner, J presses Run workflow on index's refresh-index.
9. **Later: the live friends link.** J adds the `CLOUDFLARE_API_TOKEN` secret to the app repo (invite apps also need `wrangler secret put HOST_KEY`), and the next push to `main` deploys and smoke-tests. For Play, tag `v0.1.0`; CI uploads to the internal track, and J fills in the listing and runs the closed test.

**Shipped, sprint day:** the artifact is published, the app PR holds the snapshot, typecheck, tests, build and `build:demo` pass, it was play-tested at phone width, and `demo/clip.json` shows the core function.
**Shipped, friends:** a deployed URL, a green smoke test, README budget notes, and at least one rules test.
**Shipped, Play:** on the internal track with the no-network check green.

### 9. Updating the platform

1. Change app_builder. Its CI must stay green; that includes the generated demo apps.
2. For each app that should take the change: `node scripts/sync-platform.mjs <app path>`, run the app's tests, and commit with a message naming the new `platform/VERSION.json` commit.
3. Never edit an app's `platform/` by hand.

### 10. Operations

- **Logs:** `wrangler tail app-<id>`.
- **Rollback:** `wrangler rollback`; CI does it on a failed smoke test.
- **Daily limit reached:** new runs and rooms are refused with `over_budget`, and apps show it plainly.
- **Remove a friend at once:**
    1. Remove their email from `platform.config.json` `allowedEmails`.
    2. Push app_builder, then `sync` and push each app.
    3. Remove them from the Access policy too.

   Removing them from the policy alone doesn't end a live session.
- **First deploy order:** the platform Worker first, since apps bind to its classes. Then the apps.

### 11. Security rules (non-negotiable)

1. No unauthenticated path reaches app code on the friends host. On the invite host, nothing but the static client is reachable without the host key, a signed room link and (to sit down) an approved invite.
2. Rooms are server-authoritative. Never trust client state, scores or timing.
3. Each player receives only their own view.
4. Minimal dependencies. Justify each; prefer platform APIs.
5. Player text goes into pages as text, never HTML. Load nothing from other origins. No inline scripts or styles.
6. Secrets live only in GitHub secrets (and Wrangler secrets, if ever needed), never in a repo.
7. Passkeys or hardware keys on Cloudflare, GitHub, Google Play and the email behind them.

### 12. Backlog

- A protocol version handshake.
- Invite mode: one subdomain per app (separate browser storage), revocable room links (a cap epoch), a per-connection join limit.
- A public privacy-policy page for Play listings.
- A real-time (`room`) sample in the template.
- A live test of hibernation and of the two *(verify)* items in the status table.
- Migrating Disk Football from RedZone (`solo` with replay). Settlers moves onto `invite` mode (its own host was the source of that mode).
