# Red Team Report — Social Analytics

Review date: 2026-09-20. Ranked P0 (critical) → P3 (low). Codebase: 162 source
files, NestJS, Sequelize/Postgres, 44 models across Meta/YouTube/TikTok/LinkedIn
ingestion. This review covers the code as it stands in this repo — it does not
cover whether the repo itself should be public (see Section 0, separate from and
prior to everything else here).

---

## Section 0 — Before anything else: provenance / publication status

**Not a code bug — a process question that needs an answer before this repo's
visibility or portfolio status changes.**

This repo's own `README.md` and `package.json` both state, in plain text, that
it was extracted from real employer code: the `package.json` description reads
*"Standalone Social Analytics backend, extracted from the CNBC admin-microservice
socialstats feature."* The `.gitignore` also references `/socialAnalytics` and
`/_old-scaffold-backup` as ignored paths — consistent with a mechanical
extraction from a larger source tree, not a from-scratch build.

The repo is currently **public** on GitHub.

- Git history was checked: no `.env` file or credential-shaped secret was ever
  committed (clean on that front specifically).
- This does not resolve the underlying question: if this is genuinely real
  employer code (even refactored/extracted), publishing it publicly may violate
  an employment agreement's IP/confidentiality terms regardless of whether
  literal secrets leaked.

**This needs a decision before it's added to any portfolio list or left public**:
confirm whether this is safe to keep public, and if there's any doubt, make the
repo private first and sort out the provenance question separately from the
code-quality findings below.

---

## Section 1 — Authorization design

### P1 — High

- **Client-token scope/path restriction is defined but never enforced.**
  `SocialStatsClientTokenService.verifyToken()` supports `expectedScope` and
  `expectedPath` checks, and tokens carry `scope`/`path` claims — but
  `ClientTokenGuard` (the only place that calls `assertToken()` in the entire
  app) calls it with **no options**, so those checks never run. Every
  client-gated route — including `instagram/audience-insights/debug` — is
  reachable by *any* valid client token regardless of what it was scoped for.
  If the intent was ever per-client or per-dashboard token restriction, that
  boundary does not currently exist in the running app; it only exists in the
  token format.
  **Method to close:** either have `ClientTokenGuard` read an
  `@RequireScope()`/`@RequirePath()` decorator per-route and pass it into
  `assertToken()`, or — if per-route scoping was never actually the intent —
  remove the unused fields so the code doesn't imply a guarantee it doesn't
  provide.

- **No endpoint or documented path actually issues a client token.**
  `createToken()` is defined but never called anywhere in the app, and no
  controller exposes it. The README describes client routes as
  "behind a signed HMAC client token" but doesn't say how one is ever obtained
  outside this codebase. As shipped, the documented quick-start
  (`npm install && npm run start:dev`) cannot produce a working authenticated
  session for either the admin routes (see P2 below) or the client routes.
  **Method to close:** document (or build) the actual issuance path — a CLI
  script, an internal-only endpoint, or a note pointing at wherever in the
  parent system this really happens.

### P2 — Medium

- **`JwtStrategy.validate()` trusts JWT claims with zero re-verification.**
  It returns `subscriber`/`data`/`rights`/`roles`/`sessionId` straight from the
  token payload — no DB lookup confirming the user/subscriber still exists, is
  still active, or still holds that role *now* rather than at token-issue time.
  This service has no login endpoint of its own (see below), so by design it's
  a pure resource server trusting tokens minted elsewhere — which makes the
  shared `JWT_SECRET` the entire trust boundary. A leaked or over-privileged
  token from whatever system issues these is accepted here at full face value
  until natural expiry, with no revocation check.
  **Method to close:** at minimum, validate the `JWT_SECRET` is actually set at
  boot (see next item); ideally add a lightweight revocation check (shared
  session/blocklist store) if this service is ever meant to enforce access
  changes faster than token expiry allows.

- **No fail-fast check that `JWT_SECRET` is actually set.** `JwtStrategy`
  passes `process.env.JWT_SECRET` straight to passport-jwt with no guard —
  contrast with `SocialStatsClientTokenService.getSecret()`, which throws a
  clear error if its secret is missing. If `JWT_SECRET` is unset, this fails
  unpredictably at first verification attempt instead of at boot with a clear
  message.
  **Method to close:** validate required env vars (this one especially) in
  `main.ts` or a config module before `app.listen()`, matching the pattern
  already used for the client-token secret.

### P3 — Low

- **Client-token verification failure reasons are returned in the error
  message** (`invalid_signature` vs `expired` vs `scope_mismatch` vs
  `not_yet_valid`). Not practically exploitable — HMAC-SHA256 with a real
  secret isn't brute-forceable regardless of the oracle — but it's free to
  tighten: return a generic "invalid token" to the client and keep the
  specific reason in server-side logs only.

- **CORS defaults wide-open if `CORS_ALLOWED_ORIGINS` is unset.**
  `main.ts`: `app.enableCors({ origin: allowedOrigins?.length > 0 ?
  allowedOrigins : true })` — `origin: true` reflects *any* requesting origin.
  This is an "insecure by default" pattern: forgetting to set one env var in a
  deployment silently opens CORS to everywhere, rather than failing closed.
  **Method to close:** default to a specific known origin (or fail startup
  with a clear error) instead of falling back to `true`.

---

## Section 2 — Everything else checked (no new issues found)

- **SQL injection:** only one raw query in the codebase
  (`ingestion-runs.service.ts`'s advisory-lock query) — properly parameterized
  via Sequelize `replacements`, not string interpolation. Clean.
- **Secret leakage in logs:** no request-body logging found; Winston logger
  doesn't appear to log raw credentials or tokens.
- **`auth/config` endpoints** (Meta, and presumably the equivalent per
  platform) return only booleans (`xConfigured: true/false`) and non-secret IDs
  (Page ID, Instagram Account ID) — no partial token/secret values leaked.
  Clean, good practice already in place.
- **Already self-documented in the README, not re-litigated here** (all
  reasonable as stated):
  - 2 known moderate `npm audit` findings remain, both assessed and explained
    as inert for this codebase (`@nestjs/core` SSE injection — no `@Sse()`
    routes exist; `uuid` via `sequelize` — vulnerable path needs a
    caller-supplied `buf` arg that `sequelize` never passes).
  - No unit tests for TikTok or LinkedIn modules, including the backfill-walk
    services.
  - OAuth tokens stored unencrypted in `*_account_tokens` tables — no
    key-management scheme in place yet. Worth treating DB access as
    equivalent to live platform-token access until that changes.
  - LinkedIn and TikTok have no client-facing API surface yet (only Meta and
    YouTube do).

---

## How to use this

Section 0 blocks nothing about *code quality* but should be resolved before this
repo's visibility or portfolio status changes — it's a decision only you can
make. Of the code findings, the two P1s (unenforced token scoping, no real
token-issuance path) are the ones worth fixing first if this service continues
being developed; both are contained to the auth layer and don't touch the
ingestion logic itself.
