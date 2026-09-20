# Dashboard Guide

How to build a frontend on this API: what data exists for each platform, what each dashboard should show, and the order to build it in.

This is written for whoever builds the UI. It assumes no familiarity with the backend.

---

## Before you start

### Which API surface to use

| Surface | Base path | Auth | Use it for |
|---|---|---|---|
| Admin | `admin/api/admin/socialstats/...` | Bearer JWT + role (`Admin`, `Super_Admin`, or `Analytics_Admin`) | Internal staff tools, anything that triggers ingestion or shows config |
| Client | `admin/api/client/socialstats/...` | `x-socialstats-client-token` header | Embedded/public-facing dashboards |

Client routes are read-only and cover the dashboard, breakdown, and content endpoints — they're the right choice for a viewer-facing dashboard. Don't ship admin JWTs to a browser client just to reach the same data.

### Three rules that will save you rework

**1. Every number has an "as of" time.** This service stores timestamped snapshots, not live values. A follower count is *what it was at the last ingestion*, not right now. Put the timestamp next to the number — on every panel. Users who don't know the freshness will read stale numbers as current and make bad calls.

**2. "No data" is three different states.** Never-ingested, ingested-and-failed, and ingested-but-the-platform-returned-nothing look identical if you render all of them as an empty chart. `GET .../ingestion/status` tells you which one you're in. An empty panel that says *"Instagram story metrics need the `instagram_manage_insights` permission"* saves a support ticket; a blank box generates one.

**3. Platform metrics are not comparable to each other.** A TikTok view, a YouTube view, and an Instagram view are three different definitions with different thresholds. Showing them summed, or side by side in one bar chart, produces a confidently wrong conclusion. Keep cross-platform views as small multiples — one panel per platform, each labelled with its own definition — rather than a single merged total.

### Chart choices

- **Trends over time** → line charts. Never stacked areas for comparing series; the layers above the baseline are unreadable.
- **Ranking** (top videos, top countries) → horizontal bar, sorted, with the value labelled. Not a pie chart — anything past five slices is unreadable.
- **Composition** (traffic sources, device split) → horizontal stacked bar for a single period; small multiples of lines if it's over time.
- **Geography** → a sorted bar list beats a choropleth for reading exact values. Use a map only when the spatial pattern itself is the insight.
- **A single number** (followers, total views) → big number plus a sparkline plus a delta versus the previous period. The delta is what people actually want.

---

## Meta — Facebook + Instagram

The richest dataset here, and the most complex UI. Facebook and Instagram are separate products sharing one auth; resist the urge to merge them into one view.

### What you have

| Endpoint | Data |
|---|---|
| `dashboard/overview` | Headline totals for both networks |
| `dashboard/content-table` | Per-post/media performance, sortable |
| `content/detail` | Single-item deep dive |
| `facebook/pages`, `facebook/posts`, `facebook/page-insights` | Facebook-side raw data |
| `instagram/profiles`, `instagram/media` | Instagram-side raw data |
| `breakdown/geo`, `videos/geo/hotspot`, `videos/geo/table` | Audience and video geography |
| `tags/overall`, `tags/detail` | Hashtag/tag performance |

Stored tables include page insights, posts, video metrics, Instagram media and story stats, and audience demographic and geo distributions.

### Layout

**Row 1 — two separate stat groups, visually divided.** Facebook: page follows, post engagements, page views, video views. Instagram: followers, reach, profile views, interactions. Each with a delta and an "as of" stamp. The visual separation matters — a single undifferentiated row of eight numbers invites false comparison.

**Row 2 — engagement trend.** One line chart, one line per network, on a shared date axis. This is the "are we growing" panel and should be the largest thing on screen.

**Row 3 — content table.** Sortable by reach, engagement, video views. Thumbnail, caption excerpt, published date, metric columns. This is where people spend their time; make sorting fast and the row clickable through to `content/detail`.

**Row 4 — audience.** Geo distribution as a sorted bar list; demographics as an age/gender pyramid.

### Build order

1. `dashboard/overview` → the stat row. Ship it. It's immediately useful alone.
2. `dashboard/content-table` → the table with sorting and pagination.
3. Trend chart from the stored snapshot history.
4. Geo and demographics.
5. Story metrics last — they're the most likely to be permission-blocked and the least load-bearing.

### Watch out for

- **Stories expire after 24 hours** and are ingested hourly. Gaps are real data loss, not a bug — label the panel so nobody files it as one.
- **Audience geo is a lifetime snapshot, not a time series.** The API returns today's distribution only. Don't render it as a trend; it will look flat and mislead.
- Instagram `impressions` no longer exists for most media types — it's `views` now. Don't build a UI around a field name that's gone.

---

## YouTube

The deepest analytics of the four. Also the one where naive charting is most likely to mislead.

### What you have

| Endpoint | Data |
|---|---|
| `dashboard/overview`, `dashboard/content-table` | Headline numbers and per-video table |
| `analytics/timeseries` | Views, watch time, subscribers over time |
| `traffic-sources`, `traffic-sources/detail` | Where views come from |
| `audience/demographics` | Age, gender, geography |
| `retention/video`, `retention/top-tracked` | Audience retention curves |
| `videos/impressions-ctr` | Impressions and click-through rate |
| `videos/top`, `videos/summary` | Ranked video performance |
| `breakdown/geo`, `breakdown/device` | Geographic and device splits |
| `live-stream/current`, `live-stream/dashboard`, `live-stream/viewer-timeline` | Live streaming |
| `analytics/content-type`, `analytics/live-vs-on-demand`, `analytics/viewer-segments` | Segmented analysis |
| `tags/overall`, `tags/country`, `tags/detail` | Tag performance |
| `quota/status` | API budget remaining |

### Layout

**Row 1 — channel stats.** Subscribers, total views, watch time, video count. Deltas and timestamp.

**Row 2 — performance trend.** Views and watch time on a dual-axis line chart, with a date range selector. Default to 28 days.

**Row 3 — two panels side by side.** Traffic sources (horizontal stacked bar) and top videos (sorted bar with thumbnails).

**Row 4 — retention.** The retention curve is YouTube's most actionable single chart — it shows exactly where viewers leave. Plot `elapsedVideoTimeRatio` on x, `audienceWatchRatio` on y, with a reference line at the typical-performance baseline.

**Separate view — live.** Only surface it when a stream is actually live. Viewer timeline updates every 2 minutes; make it obvious whether you're showing live or historical.

### Build order

1. Channel stats row.
2. Views/watch-time trend.
3. Video table with CTR and impressions — this is what creators act on.
4. Traffic sources.
5. Retention curves.
6. Live dashboard, only if you actually stream.

### Watch out for

- **The 2026-08-24 view-counting change.** YouTube redefined a view as starting at playback rather than after an engagement threshold. Any series crossing that date has a step change that is *not* growth. Annotate the date on every view-count chart, and offer `engagedViews` as the comparison metric across the boundary. If you skip this, someone will present a fake 30% jump to a stakeholder.
- **Analytics data lags 2–3 days.** Either trim the axis to exclude the incomplete tail or shade it as provisional. An unlabelled cliff at the right edge reads as a collapse in performance.
- **Show remaining quota in the admin UI.** Data API v3 allows 10,000 units/day, reset at midnight Pacific. When a dashboard stops refreshing mid-afternoon, exhausted quota is the usual cause, and `quota/status` makes it self-diagnosable.

---

## TikTok

Smallest surface of the four — profile stats and video stats. Design for that rather than promising more.

### What you have

| Endpoint | Data |
|---|---|
| `account/overview` | Followers, following, likes, video count, verified status |
| `videos/statistics` | Per-video views, likes, comments, shares |
| `auth/status` | Token state and expiry |
| `rate-limits` | Request budget |

Stored as `tiktok_account_stats` and `tiktok_video_stats` snapshots.

### Layout

**Row 1 — account stats.** Followers, total likes, video count, with deltas since the last snapshot.

**Row 2 — follower trend.** A single line chart from the snapshot history. Sparse at first — snapshots are daily — so don't over-design for density you won't have for weeks.

**Row 3 — video grid.** TikTok is a visual medium; a thumbnail grid with overlaid view counts fits the content better than a dense table. Sort by views, likes, or recency.

**Row 4 — engagement rate per video.** (likes + comments + shares) ÷ views, as a sorted bar. This is the metric that actually distinguishes performance, since raw views are dominated by whatever the algorithm pushed.

### Build order

1. Account overview stats.
2. Video grid.
3. Follower trend (needs several days of snapshots before it's meaningful).
4. Engagement-rate analysis.

### Watch out for

- **Token expiry needs to be visible.** Access tokens last 24 hours, refresh tokens 365 days. Surface `auth/status` somewhere in the admin UI — TikTok is the platform most likely to silently stop working.
- **Deleted videos disappear.** The retention sweep removes content the creator deleted, as TikTok's terms require. A video vanishing from history is correct behaviour; say so in the UI rather than letting it look like data loss.
- **Only daily granularity.** Don't build hourly charts; there's no hourly data.

---

## LinkedIn

B2B-focused, and uniquely strong on *who* the audience is — seven demographic facets, which no other platform here matches.

### What you have

| Endpoint | Data |
|---|---|
| `organization/overview` | Follower count, total page views |
| `followers/statistics` | Followers by country, function, industry, seniority, company size, association type, geo |
| `page/statistics` | Page views: all, desktop, mobile, careers page; unique visitors |
| `shares/statistics` | Impressions, unique impressions, clicks, likes, comments, shares, engagement rate |

### Layout

**Row 1 — organization stats.** Followers, page views, engagement rate.

**Row 2 — follower demographics.** This is LinkedIn's differentiator and deserves the most space. A faceted view — industry, job function, seniority, company size — each a sorted horizontal bar. For a B2B audience this answers "are we reaching the right people", which matters more than raw follower count.

**Row 3 — page traffic.** Desktop versus mobile versus careers page over time. The careers-page split is genuinely useful to recruiting teams — don't bury it.

**Row 4 — share performance.** Impressions, clicks, CTR, engagement rate per post.

### Build order

1. Organization overview.
2. Follower demographics — the highest-value panel. Build it properly.
3. Share/post performance.
4. Page traffic breakdown.

### Watch out for

- **Follower statistics are lifetime aggregates, not deltas.** Segments show the current composition of your audience, not who joined recently. Label accordingly or people will read it as acquisition data.
- **Development Tier allows 500 requests/day.** A dashboard that refetches aggressively will exhaust it. Serve from stored snapshots and refresh on a schedule, not per page load.
- **Surface token age.** Access tokens expire after ~60 days and, without partner-tier approval, re-authorisation is manual. A countdown in the admin UI prevents a silent two-month-later outage.

---

## Cross-platform overview

Once the individual dashboards work, an executive summary view is worth building — with care.

**Do:** small multiples, one panel per platform, each with its own scale and its own metric definition labelled. A consistent panel shape makes them scannable without implying the numbers are equivalent.

**Do:** normalise to rates when comparing. Engagement *rate* (interactions ÷ reach) is defensible across platforms in a way that raw counts are not.

**Don't:** sum views across platforms into one "total reach" number. The definitions differ enough that the total is meaningless, and it's the single most common way social dashboards mislead the people reading them.

**Do:** include an ingestion-health strip — last successful run per platform, with anything stale flagged. It's the first thing to check when numbers look wrong, and it turns "the dashboard is broken" into "LinkedIn's token expired."

---

## Implementation notes

**Cache on the frontend.** The backend already caches briefly, but platform quotas are the real constraint. Serve from stored snapshots; reserve live pass-through endpoints for explicit refresh actions.

**Date ranges:** default to 28 days. Offer 7 / 28 / 90 / custom. Most platform APIs won't return meaningful data beyond about 12 months.

**Empty states:** distinguish "not configured", "no data yet", and "failed" — and for each, say what to do next. `ingestion/status` gives you the distinction; use it.

**Errors:** a 401 on client routes means the client token is missing, malformed, or expired — not that the user lacks permission. Say that, rather than rendering a generic access-denied page.

**Mobile:** stat rows and trend charts translate fine. Wide content tables don't — switch to cards below roughly 768px rather than forcing a horizontal scroll.
