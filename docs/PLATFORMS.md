# Platform Guide

How to set up, operate, and troubleshoot each of the four platforms.

Platform behaviour was verified against live vendor documentation on **2026-09-20**. Social APIs deprecate fields and versions on a rolling basis — the "Version and expiry" notes below tell you when each one needs revisiting.

**Common pattern:** every platform is optional and independent. Leave its variables blank and its cron jobs skip silently rather than failing. Every platform exposes:

- `GET .../auth/config` — are the environment variables set? (no network call)
- `GET .../auth/verify` — do the credentials *actually work right now*? (one minimal live call)

When something looks broken, run `auth/verify` first. It distinguishes "not configured" from "configured but rejected by the platform", which are different problems with different fixes.

---

## Meta — Facebook + Instagram

Largest module in the service. Covers Facebook Pages (posts, reels, video metrics, page insights) and Instagram Business accounts (media, stories, audience insights), plus geographic breakdowns for both.

### Credentials

| Variable | What it is |
|---|---|
| `META_APP_ID` / `META_APP_SECRET` | From your app at [developers.facebook.com](https://developers.facebook.com) |
| `META_SYSTEM_USER_TOKEN` | **Recommended.** A Business Manager system user token — doesn't expire, correct choice for server-to-server ingestion |
| `META_ACCESS_TOKEN` | Legacy fallback. A short-lived user token you exchange via `POST auth/exchange-user-token` |
| `META_PAGE_ID` | The numeric Facebook Page ID to ingest |
| `META_INSTAGRAM_ACCOUNT_ID` | The connected Instagram Business account ID |
| `META_REDIRECT_URI` | Only needed for the user-token exchange flow |

Sent on the wire as standard OAuth `client_id` / `client_secret`.

### Setup

1. Create an app at developers.facebook.com and add the **Facebook Login** and **Instagram Graph API** products.
2. Request the permissions you need: `pages_read_engagement`, `pages_show_list`, `read_insights`, `instagram_basic`, `instagram_manage_insights`. Anything touching Page or Instagram insights needs App Review before it works outside your own test assets.
3. Create a **system user** in Business Manager, assign it to the Page and the Instagram account, and generate a non-expiring token. Put it in `META_SYSTEM_USER_TOKEN`.
4. Run `POST admin/api/admin/socialstats/meta/auth/bootstrap` — this derives and stores the Page token from the system user token.
5. Confirm with `GET .../meta/auth/verify`.

### Version and expiry

`META_GRAPH_API_VERSION` is currently `v26.0`. Meta supports each version for roughly two years from release, then hard-fails calls against it. Check the [changelog](https://developers.facebook.com/docs/graph-api/changelog/) roughly twice a year and bump.

### Scheduled jobs

| Cron | Job |
|---|---|
| `5 0 * * *` | Profile snapshot (follower counts, page-level totals) |
| `10 */6 * * *` | Content snapshot (posts, reels, media metrics) |
| `20 * * * *` | Story snapshot — hourly, because Instagram stories expire after 24h and the data is gone once they do |
| `35 0 * * *` | Geo snapshot (audience country/city distribution) |

Each is individually switchable via `META_*_SNAPSHOT_CRON_ENABLED`.

### Rate limits

Meta runs three parallel limit systems and reports each in response headers: `X-App-Usage`, `X-Page-Usage`, `X-Business-Use-Case-Usage`. `MetaRateLimitService` reads all three and cools down on the **highest** observed percentage, which is the correct approach — steering on call count alone will get you throttled. Inspect current state at `GET .../meta/rate-limits`.

Tunable via `META_RATE_LIMIT_USAGE_THRESHOLD_PERCENT` (default 80) and `META_RATE_LIMIT_COOLDOWN_SECONDS`.

### Gotchas

- **Metric names churn constantly.** Meta retires Page Insights metrics on a rolling schedule. The ingest service handles this with *candidate arrays* — each metric lists fallbacks and tries them in order, so a deprecation degrades to a logged warning and a `data_coverage` record rather than a crash. When adding metrics, follow that pattern.
- **`page_fans_country` / `page_fans_city` were deprecated 2025-11-15** in favour of `page_follows_country` / `page_follows_city`. Both are configured as candidates.
- **Instagram `impressions` is gone** for stories and most media types, consolidated into `views` from v22.0. Already reflected in the metric sets.
- **Backfill is limited.** Audience geo is a lifetime snapshot — the API only returns *today's* distribution, so historical geo backfill would fabricate data. The code deliberately refuses to do it.

---

## YouTube

Three distinct Google APIs: **Data API v3** (channel/video metadata), **Analytics API** (time-series, demographics, traffic sources, retention), and **Reporting API** (bulk CSV reach reports).

### Credentials

| Variable | What it is |
|---|---|
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | OAuth 2.0 client from Google Cloud Console |
| `YOUTUBE_REFRESH_TOKEN` | Offline-access refresh token for the channel owner |
| `YOUTUBE_AUTH_FILE_PATH` | Alternative to the refresh token — a JSON file holding it |

You need either `YOUTUBE_REFRESH_TOKEN` or a valid `YOUTUBE_AUTH_FILE_PATH`.

### Setup

1. In Google Cloud Console, create a project and enable **YouTube Data API v3**, **YouTube Analytics API**, and **YouTube Reporting API**.
2. Create an OAuth 2.0 Client ID (type: Web application or Desktop).
3. Consent screen: request `yt-analytics.readonly`, `yt-analytics-monetary.readonly` (only if you need revenue), and `youtube.readonly`.
4. Complete the consent flow **as the channel owner** with `access_type=offline` and store the resulting refresh token.
5. Confirm with `GET .../youtube/auth/verify`.

> **Set the consent screen to "Production", not "Testing."** Refresh tokens issued by a Testing-status screen expire after **7 days**, which produces a service that mysteriously stops ingesting every week. This is the single most common YouTube setup mistake.

Refresh tokens also expire after 6 months of non-use, and Google caps you at 100 live refresh tokens per client.

### Quotas

Data API v3 gets **10,000 units/day** by default, resetting at **midnight Pacific**. `YoutubeQuotaService` tracks spend and refuses calls that would exceed the budget, holding back `YOUTUBE_HOT_TIER_RESERVE_UNITS` for high-priority work.

Verified current costs: `videos.list`, `channels.list`, and `liveBroadcasts.list` all cost **1 unit** regardless of how many `part` values you request. `search.list` costs **100** — this code never calls it, and you should keep it that way.

The Analytics API has a separate call-count budget (`YOUTUBE_ANALYTICS_DAILY_CALL_BUDGET`). The Reporting API is effectively free and isn't metered here.

Check state at `GET .../youtube/quota/status`.

### Scheduled jobs

| Cron | Job |
|---|---|
| `0 * * * *` | Channel + video stats (hourly) |
| `*/2 * * * *` | Live viewer snapshots — every 2 minutes, only while a stream is live |
| `20 0 * * *` | Daily analytics snapshot |
| `15 0 * * *` | Video retention stats |
| `45 0 * * *` | Geo + device breakdown |
| `30 3 * * *` | Reach reports (Reporting API bulk CSV) |

### Gotchas

- **YouTube changed how views are counted on 2026-08-24.** A view now registers the moment playback begins — including autoplay and hover — replacing the old engagement-threshold rule for Shorts. Any view-count series spanning that date has a **step change that is a policy artifact, not growth.** The service already collects `engagedViews` alongside `views`; use that for like-for-like comparisons across the boundary, and annotate the date on your charts.
- **Analytics data lags 2–3 days.** Don't treat a gap at the right edge of a chart as a failure.
- **`dislikeCount` has been owner-only since 2021.** The dislike figures here come from the Analytics API, which still reports them for your own channel.

---

## TikTok

Uses **Login Kit** (OAuth) and the **Display API** (profile stats, video list). Deliberately does *not* touch the Research API, which is restricted to approved academic and non-profit researchers and explicitly bars commercial use.

Full walkthrough: `src/socialstats/tiktok/SETUP_STEPS.txt`

### Credentials

| Variable | What it is |
|---|---|
| `TIKTOK_CLIENT_KEY` | **Not** client ID — see below |
| `TIKTOK_CLIENT_SECRET` | App secret |
| `TIKTOK_REDIRECT_URI` | Must match the app config exactly |
| `TIKTOK_SCOPES` | Defaults cover profile + video list |

> **TikTok calls it `client_key`, not `client_id`.** It's the only platform here that does. Sending `client_id` fails with an unhelpful error. The code sends `client_key` correctly — just don't "fix" it.

### Setup

1. Register at [developers.tiktok.com](https://developers.tiktok.com), create an app, note the Client Key and Secret.
2. Add the **Login Kit** and **Display API** products.
3. Enable scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`. The consent screen can only offer what the app is registered for.
4. `GET .../tiktok/auth/authorize-url` → open it → approve → copy the `code` and `state` from the address bar.
5. `POST .../tiktok/auth/exchange` with both values.
6. Confirm with `GET .../tiktok/auth/verify`.

Production access needs TikTok's app review. Budget time for it.

### Token lifecycle

Access tokens last **24 hours**; refresh tokens last **365 days** and **rotate on every refresh** — each refresh invalidates the previous refresh token, so the new one must be persisted or you lose access. A cron at `0 */6 * * *` refreshes well inside the 24h window so a transient failure still leaves several retries.

### Scheduled jobs

| Cron | Job |
|---|---|
| `0 */6 * * *` | Token refresh |
| `10 2 * * *` | Account overview |
| `20 2 * * *` | Video statistics |
| `45 3 * * *` | Retention purge — **required by TikTok's Developer Terms** |

### Gotchas

- **TikTok answers failures with HTTP 200.** The error lives in the response body; `error.code === 'ok'` is the only reliable success signal. `TiktokApiService.unwrap()` handles this. Treating 200 as success — as you would for any other platform here — silently writes empty analytics rows.
- **Since the February 2024 scope migration, `user.info.basic` no longer returns follower counts.** You need `user.info.stats`. Without it every call still returns 200 and the numbers are simply absent; the module reports this as `unavailable_permission`.
- **The retention sweep is a Terms obligation, not an optimisation.** It drops content the creator deleted and ages out old snapshots. `POST auth/revoke` similarly revokes *and* purges — keeping harvested analytics after revoking access would not satisfy TikTok's terms.
- Documented rate limit is **600 requests/minute**, applied per endpoint. `TIKTOK_REQUESTS_PER_MINUTE` in `.env.example` is set conservatively; raise it if you increase ingestion frequency.

---

## LinkedIn

Uses the **Community Management API** for organization page analytics: follower statistics (segmented by seven demographic facets), page statistics, and share statistics.

Full walkthrough: `src/socialstats/linkedin/SETUP_STEPS.txt`

### Credentials

| Variable | What it is |
|---|---|
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | From your app at [developer.linkedin.com](https://developer.linkedin.com) |
| `LINKEDIN_REDIRECT_URI` | Exact match required |
| `LINKEDIN_ORGANIZATION_ID` *or* `LINKEDIN_ORGANIZATION_URN` | Numeric page ID, or the full `urn:li:organization:{id}` form |
| `LINKEDIN_API_VERSION` | `YYYYMM` version header — see below |

### Setup

1. Create an app and associate it with the Company Page you administer.
2. Request the **Community Management API** product. You get **Development Tier** first (500 requests/day per app, 100/day per member) — enough to build and test.
3. For production, apply for **Standard Tier**. LinkedIn requires a screencast demonstrating the use case. There is no way around the review.
4. Scope needed: **`rw_organization_admin`**. That single scope covers follower, page, and share statistics plus network size. (`r_organization_social` and `r_organization_followers` are *not* what these endpoints require.)
5. `GET .../linkedin/auth/authorize-url` → approve → copy `code` and `state` → `POST .../linkedin/auth/exchange`.
6. Confirm with `GET .../linkedin/auth/verify`.

### Version and expiry — read this

LinkedIn requires a `LinkedIn-Version: YYYYMM` header on every request, and **each version is supported for only about 12 months** before calls against it are rejected outright.

Current default is **`202608`**. This needs bumping roughly annually — put a calendar reminder on it. Symptom of a lapsed version: every LinkedIn call fails at once with a version-deprecated error, with no other change on your side. Check [the versioning page](https://learn.microsoft.com/en-us/linkedin/marketing/versioning) for what's current.

### Scheduled jobs

| Cron | Job |
|---|---|
| `10 1 * * *` | Organization overview |
| `20 1 * * *` | Follower statistics |
| `30 1 * * *` | Page statistics |
| `40 1 * * *` | Share statistics |

### Gotchas

- **Access tokens last ~60 days, and refresh tokens are gated behind Marketing Developer Platform partner approval.** Without partner status you re-authorise manually every two months. Plan for it — this catches teams out.
- **Quota defaults match Development Tier** (500/day app, 100/day member). Raise `LINKEDIN_DAILY_APP_REQUEST_BUDGET` after Standard Tier approval, or the local guard will throttle you below your real allowance.
- `edgeType=COMPANY_FOLLOWED_BY_MEMBER` (uppercase) is required from v202305 onward. The older `CompanyFollowedByMember` spelling is not retrocompatible.

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Dashboard empty for one platform | `GET .../ingestion/status` — distinguishes never-ran / failed / ran-but-empty |
| A platform stopped working overnight | `GET .../{platform}/auth/verify`. For LinkedIn also check the version header hasn't lapsed; for YouTube check whether the consent screen is still in Testing status |
| Data present but a specific metric missing | `data_coverage` records — `unavailable_permission` means a missing scope, `unavailable_unsupported` means the platform retired the metric |
| Ingestion running but rate-limited | `GET .../{platform}/rate-limits` or `.../quota/status` |
| Need to stop jobs without redeploying | `POST .../ingestion/pause` (platform or job-type scope), reverse with `.../resume` |
