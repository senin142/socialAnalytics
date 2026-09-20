# Social Analytics

A standalone NestJS service that ingests analytics from Meta (Facebook + Instagram), YouTube, TikTok, and LinkedIn into PostgreSQL, and serves it back through a REST API for dashboards.

It was extracted from a larger monorepo's `socialstats` feature into a self-contained service with no external workspace dependencies.

---

## What it does

**Ingests** — scheduled cron jobs pull metrics from each platform's API and write timestamped snapshots to Postgres. Every run is tracked (started / completed / failed, with record counts) so you can see what ran and what broke.

**Serves** — REST endpoints expose both the stored history and live pass-through reads, split into two surfaces:

- `admin/api/admin/socialstats/...` — staff routes, behind JWT + role checks
- `admin/api/client/socialstats/...` — client routes, behind a signed HMAC client token

---

## Quick start

**Requirements:** Node.js 18+ (16.20 works but several dev dependencies warn), PostgreSQL 13+, npm.

```bash
git clone https://github.com/senin142/socialAnalytics.git
cd socialAnalytics
npm install
cp .env.example .env
```

Now open `.env` and fill it in. **Every credential field ships blank on purpose** — there are no working defaults and nothing is pre-populated. At minimum you need the database block and `JWT_SECRET` before the service will start:

```
DATABASE_NAME=
DATABASE_USERNAME=
DATABASE_PASSWORD=
WRITE_DATABASE_HOST=
READ_DATABASE_HOST=
JWT_SECRET=
```

Then:

```bash
npm run build
npm run start:dev     # watch mode
npm run start:prod    # from dist/
```

The service will refuse to boot if it can't reach Postgres — that's deliberate, it fails loudly rather than running with no storage.

Health check: `GET /health` (public, no auth — safe for liveness probes).

### Platform credentials

Each platform is independent and **optional**. Leave a platform's variables blank and its cron jobs skip quietly — they don't error, they just no-op until configured. This means you can run with only YouTube configured, or only Meta, and add the rest later.

See **[docs/PLATFORMS.md](docs/PLATFORMS.md)** for how to obtain credentials for each platform, including which ones need vendor approval before they return any data (LinkedIn and TikTok both do, and the approvals are not instant).

---

## Documentation

| Doc | What's in it |
|---|---|
| **[docs/PLATFORMS.md](docs/PLATFORMS.md)** | How to set up and operate each platform: credentials, OAuth flow, endpoints, cron schedules, quotas, and the gotchas specific to each API |
| **[docs/DASHBOARD_GUIDE.md](docs/DASHBOARD_GUIDE.md)** | How to build a frontend on this API — what data exists per platform, what each dashboard should show, and a build order |
| **[docs/OVERVIEW_PAGE.md](docs/OVERVIEW_PAGE.md)** | Building the single all-platforms overview page: the two blockers to settle first, layout, and how to compare platforms without misleading people |
| **[docs/SEO.md](docs/SEO.md)** | Per-platform SEO and discoverability recommendations, tied to the metrics this service actually collects |
| `src/socialstats/linkedin/SETUP_STEPS.txt` | LinkedIn's full step-by-step approval and auth walkthrough |
| `src/socialstats/tiktok/SETUP_STEPS.txt` | TikTok's full step-by-step approval and auth walkthrough |

---

## Architecture

```
src/
  main.ts                  Bootstrap: validation pipe, CORS, port
  app.module.ts            Root: config, schedule, database, health, socialstats

  auth/                    JWT strategy, JwtAuthGuard, RolesGuard,
                           ClientTokenGuard, @Public() / @Roles() decorators
  enums/                   RoleTypes
  common/logger/           Winston daily-rotate file logger
  database/
    database.module.ts     Wraps the Sequelize connection
    entity/                44 Sequelize models + the Entities[] registry
    providers/             Repository-token DI providers (one per model)

  socialstats/
    socialstats.module.ts  Wires all four platforms
    shared/                Ingestion run tracking, pause/resume control,
                           data coverage, client token issuing/verifying
    meta/                  Facebook + Instagram
    youtube/               Data API v3 + Analytics API + Reporting API
    tiktok/                Display API
    linkedin/              Community Management API
```

**Why Sequelize repository tokens instead of `@InjectModel`:** carried over from the source monorepo, where models are bound to string tokens (`'YOUTUBE_CHANNEL_STATS_REPOSITORY'`) by provider files. Keeping the pattern made the extraction a near-verbatim copy, which kept the diff reviewable.

### Auth model

Three layers, all active at once:

1. **`JwtAuthGuard`** (global) — every route needs a bearer JWT unless marked `@Public()`
2. **`RolesGuard`** (global) — admin routes additionally require `Admin`, `Super_Admin`, or `Analytics_Admin`
3. **`ClientTokenGuard`** — client routes are `@Public()` to the JWT layer but require a signed HMAC token from `SocialStatsClientTokenService`, sent as `x-socialstats-client-token` (also accepts `x-client-token`, `Authorization: Bearer`, or `?clientToken=`)

Set `SOCIALSTATS_CLIENT_TOKEN_SECRET` before using client routes — the token service throws without it, so those routes fail closed rather than open.

Rate limiting is global via `@nestjs/throttler` (100 requests / 60s by default).

---

## Operating it

**Ingestion status** — `GET admin/api/admin/socialstats/ingestion/status` returns per-platform run history and data coverage. Start here when a dashboard looks empty: it distinguishes "never ran", "ran and failed", and "ran but the platform returned nothing" (e.g. a missing scope), which are three very different problems.

**Pause / resume** — `POST .../ingestion/pause` and `.../ingestion/resume` stop scheduled jobs at platform or job-type scope without redeploying. Useful when a platform is rate-limiting you or an API migration is mid-flight.

**Credential checks** — every platform has `GET .../{platform}/auth/verify`, which makes one minimal live API call and returns `{ valid, checkedAt, ... }`. This is the fastest way to answer "are these keys still good?" — distinct from `auth/config`, which only reports whether the environment variables are *set*.

**Logs** — Winston writes daily-rotating files to `LOGS_BASE_PATH`. Ingestion failures land in the error log with the platform and job type.

---

## Scripts

```bash
npm run build         # nest build
npm run start:dev     # watch mode
npm run start:prod    # node dist/main
npm run lint          # eslint --fix
npm test              # jest unit tests
npm run test:e2e      # e2e (needs a reachable database)
```

---

## Status and known gaps

All four platforms are wired, the full DI graph boots clean, `nest build` is clean, and all 8 test suites (65 tests) pass.

- **2 known moderate vulnerabilities remain in production dependencies** (down from 14, including all 3 highs — see `package.json`'s `overrides` block for `multer`/`body-parser`/`lodash`/`qs`/`file-type`, all same-major-line patches with no code changes needed). Both remaining ones are confirmed inert for this codebase, not just low-priority:
  - **`@nestjs/core` SSE event injection** ([GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75)) — requires an `@Sse()` route mapping attacker-controlled data into event fields; this codebase has none. The fix (`@nestjs/core@11.1.18`+) requires **Node ≥20**, and this dev environment runs Node 16.20.2 — every `@nestjs/*` package on that line has required Node 20 since 11.0.0, so there's no smaller intermediate step available. Revisit once the deployment target is on Node 20+.
  - **`uuid` (via `sequelize`)** ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)) — the vulnerable code path requires a caller-supplied `buf` argument; `sequelize` only calls `uuid().v4()` with no arguments (for internal transaction IDs). Forcing an override here would mean jumping `uuid` 8.x → 11.x across a real breaking API change, for a vulnerability that isn't reachable either way — not worth the risk.
- **No unit tests for TikTok or LinkedIn** — neither module came with specs, including the newly added backfill-walk services.
- **OAuth tokens are stored unencrypted** in `*_account_tokens` tables. Inherited from the source implementation. A database read compromise yields live platform tokens, so treat DB access accordingly; encryption at rest would need a key-management scheme this service doesn't have yet.
- **LinkedIn and TikTok require vendor approval** before returning data. Until approved, their jobs skip quietly by design.
- **TikTok and LinkedIn have no client-facing API** (only Meta and YouTube do) — see [docs/OVERVIEW_PAGE.md](docs/OVERVIEW_PAGE.md) if you're building a cross-platform dashboard, since this limits what a client-token page can show today.
- **Nothing has been run against a real database yet.** Every check this session (build, boot, backfill-walk wiring) stops at the same wall: no real Postgres credentials have been provided, so none of this has been verified against live data or a live platform API.
