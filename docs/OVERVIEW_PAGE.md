# Building the All-Platforms Overview Page

How to build a single page summarising Meta, YouTube, TikTok, and LinkedIn together.

This is the hardest page in the product to get right, and the easiest one to get confidently wrong. The per-platform dashboards in [DASHBOARD_GUIDE.md](DASHBOARD_GUIDE.md) only have to report numbers accurately. An overview page has to make four incompatible datasets *comparable* — and the shortcuts that make it look clean are the ones that make it lie.

Read the two blockers below before designing anything; both change what's feasible.

---

## Blocker 1: TikTok and LinkedIn have no client-facing API

Only Meta and YouTube expose client controllers:

| Platform | Admin surface | Client surface |
|---|---|---|
| Meta | `admin/api/admin/socialstats/meta` | ✅ `admin/api/client/socialstats/meta` |
| YouTube | `admin/api/admin/socialstats/youtube` | ✅ `admin/api/client/socialstats/youtube` |
| TikTok | `admin/api/admin/socialstats/tiktok` | ❌ none |
| LinkedIn | `admin/api/admin/socialstats/linkedin` | ❌ none |

**So a client-token overview page can only show half the platforms today.** Three options:

1. **Build it admin-only** (JWT + `Analytics_Admin` role). Zero backend work, all four platforms, internal audience only. Start here unless you already know the page must be client-facing.
2. **Add client controllers for TikTok and LinkedIn**, mirroring the Meta/YouTube pattern — `@Public()` + `@UseGuards(ClientTokenGuard)` at class level, read-only routes only. Roughly a day's work per platform.
3. **Add one aggregate client endpoint** that composes all four server-side (see Blocker 2). Best end state, most work.

Whichever you pick, decide it *before* building the UI — retrofitting an auth surface after the fact means rewriting every fetch in the page.

## Blocker 2: there is no cross-platform metrics endpoint

The only genuinely cross-platform endpoint is `GET admin/api/admin/socialstats/ingestion/status`, and it reports *pipeline health*, not metrics. There is nothing that returns "followers across all platforms."

Two ways to solve it:

**Client-side fan-out** — the page issues four parallel requests and composes the result in the browser.
*Good:* no backend work, ships immediately, each platform's own caching still applies, one platform failing degrades that panel instead of the page.
*Bad:* four round trips, normalisation logic lives in the frontend where it's harder to test, and each client re-derives it.

**Backend aggregate endpoint** — add `GET .../socialstats/overview` that fans out server-side and returns one normalised payload.
*Good:* one request, one place to define normalisation, cacheable as a unit, and it's where the "these metrics aren't comparable" rules belong — enforced once rather than trusted to every consumer.
*Bad:* real backend work, and you must handle partial failure explicitly (see below).

**Recommendation: start with client-side fan-out, move to an aggregate endpoint once the page's shape has stopped changing.** The normalisation rules are the part worth getting right, and you'll discover what they should be by building the page first. Premature aggregation locks in a response shape before you know what the page needs.

> If you do build the aggregate endpoint: **never let one platform's failure fail the whole response.** Use `Promise.allSettled`, return per-platform `{ status: 'ok' | 'error', data, error }`, and let the page render three panels plus one error state. A 500 because LinkedIn's token expired is a bad trade.

---

## What you have to work with

### Headline endpoints per platform

| Platform | Endpoint | Returns |
|---|---|---|
| Meta | `dashboard/overview` | Pages, profiles, Facebook posts, Instagram media. Takes a `platform` filter (`facebook` / `instagram` / both) |
| YouTube | `dashboard/overview` | `views`, `watchTimeHours`, `subscribersGained`, `subscribersLost`. Takes a `metricSet` param |
| TikTok | `account/overview` | Followers, following, likes, video count, verified status |
| LinkedIn | `organization/overview` | Follower count, total page views |

Note the naming is inconsistent — `dashboard/overview` for two platforms, `account/overview` and `organization/overview` for the others. Don't build a URL from a template string; map them explicitly.

### Ingestion cadence differs per platform

This matters more than it sounds. Panels on one page will have genuinely different ages:

| Platform | Job | Runs | Considered stale after |
|---|---|---|---|
| YouTube | Channel stats | Hourly | 3 hours |
| YouTube | Live viewers | Every 2 min | 10 minutes |
| Meta | Story snapshot | Hourly | — |
| Meta | Content snapshot | Every 6h | 12 hours |
| Meta | Profile / geo snapshot | Daily | 36 hours |
| LinkedIn | All four jobs | Daily ~01:00 | 36 hours |
| TikTok | Account + video stats | Daily ~02:00 | 36 hours |

So a YouTube number may be 20 minutes old while the LinkedIn number next to it is 14 hours old. **Both are correct and current for their platform.** The page has to communicate that without making the LinkedIn panel look broken.

---

## Page layout

### 1. Ingestion health strip — top of page, full width

Put this *first*, above the metrics. When numbers look wrong this is the answer, and having it at the top converts "the dashboard is broken" into "LinkedIn's token expired" without a support ticket.

Drive it from `GET .../ingestion/status`, which already computes exactly this. The status vocabulary is fixed — use it verbatim rather than inventing your own:

| Status | Meaning | Suggested treatment |
|---|---|---|
| `fresh` | All jobs current | Green, minimal |
| `stale` | A job hasn't run within its staleness window | Amber — needs attention |
| `degraded` | A job is missing, or the latest run of a job failed | Amber/red |
| `paused` | An admin deliberately paused it | Blue/grey — **must not look like an error** |
| `missing` | Nothing tracked — platform never configured | Grey, with "set up" affordance |

The endpoint also returns an `overall` rollup with precedence `stale > degraded > paused > fresh > missing`. Use it for a single at-a-glance indicator, but keep the per-platform breakdown expandable underneath — the rollup alone doesn't say *which* platform is unhappy.

`paused` deserves the care: it's an intentional admin action, and rendering it in the same red as a failure trains people to ignore the strip.

### 2. Platform summary cards — one per platform, equal size

Four cards, identical shape, each with:

- Platform name and icon
- **Its own primary metric**, with the metric's name stated — followers for TikTok/LinkedIn, subscribers for YouTube, page follows + IG followers for Meta
- Delta versus the previous period
- A sparkline
- **An "as of" timestamp** — non-negotiable given the cadence differences above
- Click-through to that platform's full dashboard

Identical card shape makes them scannable. Explicit per-card metric labels stop the shape from implying the numbers are the same kind of thing. That tension — consistent form, explicit labels — is the whole design problem of this page in miniature.

### 3. Cross-platform trend — small multiples, not one merged chart

Four small line charts sharing a date axis and a time-range selector, **each with its own y-axis scale.**

Do not merge four platforms into one chart with a shared y-axis. YouTube's view counts will be orders of magnitude above LinkedIn's impressions; LinkedIn flatlines at the bottom and the chart says "LinkedIn is irrelevant" when it may be your highest-value audience. Small multiples let each platform's *shape* be read, which is the actual question — is it going up or down.

### 4. Normalised comparison — the one place cross-platform numbers are legitimate

Rates are comparable in a way counts are not. Build one panel around **engagement rate** — interactions ÷ reach (or ÷ views where reach isn't available) — as a sorted horizontal bar, one bar per platform.

State the formula on the panel. Each platform defines interactions slightly differently, and a reader who can see the formula can judge the comparison for themselves. A reader who can't will either over-trust it or dismiss it.

### 5. Top content across platforms

A unified table or card grid of best-performing content from all four, **sorted by a normalised rate rather than raw views**, with a platform badge on each row.

Sorting this by raw views produces a list that is 90% YouTube every time — not because YouTube content performs better, but because YouTube counts views more permissively. That table looks like insight and isn't.

---

## What to compute

**Deltas, always.** A number without a comparison is nearly useless. Every headline metric gets a change-versus-previous-period value. Match the comparison window to the selected range (28 days selected → compare against the prior 28 days).

**Share of total, carefully.** "40% of engagement came from Instagram" is a legitimate and useful framing — *if* engagement is defined consistently across platforms. Do this for engagement and interactions. Don't do it for views.

**Never sum views across platforms.** A YouTube view (playback start, since 2026-08-24), a TikTok view, and an Instagram view are three different events with three different thresholds. A combined "total reach" number is the single most common way social dashboards mislead the people who act on them. If leadership demands one number, give them total *engagement* (interactions are much closer to comparable) and label its composition.

**Per-platform "as of", not one page-level timestamp.** A single "last updated" at the top is a lie the moment two platforms differ in age — which, given the cadence table, is always.

---

## Build order

1. **Health strip.** One endpoint, immediately useful on its own, and it tells you whether the rest of the page will have data. Ship it alone if you want something in front of users this week.
2. **Four summary cards** via client-side fan-out. This is the page's core value.
3. **Small-multiple trends.**
4. **Normalised engagement comparison.** Do this only after you've agreed the formula with whoever reads the page — it's a definitional decision, not a technical one.
5. **Cross-platform top content.**
6. **Aggregate backend endpoint**, once the shape has settled and you want one cached payload.

Steps 1–2 deliver most of the value. Steps 4–5 are where the page either earns trust or quietly loses it.

---

## Pitfalls

**Averaging across platforms.** "Average engagement rate: 4.2%" across four platforms with wildly different baselines is a number with no referent. Show four rates.

**A single page-level refresh button.** Implies all four platforms refresh together; they don't, and platform quotas mean aggressive refetching will exhaust LinkedIn's Development Tier budget (500/day) fast. Serve from stored snapshots; make refresh per-platform and explicit.

**Treating an unconfigured platform as zero.** A platform with no credentials should render as "not connected" with a setup link, never as `0`. Zero is a measurement; unconfigured is the absence of one, and charting them identically is how a dashboard reports a 100% decline that never happened.

**Hiding failures to keep the page tidy.** A platform whose last ingestion failed should say so on its card, not silently display last week's number as though it were current. Stale-but-labelled beats fresh-looking-but-wrong.

**One "total followers" number.** A YouTube subscriber, a LinkedIn company-page follower, and a TikTok follower represent very different levels of commitment. Summing them produces a big number that means nothing. If you need one audience figure, show the four side by side and let the reader add them up if they want to — at least then the addition is theirs.
