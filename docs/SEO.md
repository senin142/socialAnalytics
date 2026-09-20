# Social SEO Recommendations

Per-platform discoverability guidance, tied to the metrics this service actually collects — so each recommendation comes with a way to measure whether it worked.

**Researched 2026-09. Platform algorithms shift faster than documentation does — re-check the specifics roughly twice a year.** Sources are listed at the end.

---

## Why this matters more than it used to

Three things changed the calculus for social SEO, and all three are recent:

**Social platforms became search engines.** TikTok, YouTube, and Instagram now carry serious in-platform search volume. TikTok search overtook Google as the discovery starting point for Gen Z back in 2024, and the gap has widened. Content that isn't optimised for in-platform search is invisible to a growing share of the audience regardless of how good it is.

**AI answer engines cite social content.** LLM-generated answers increasingly reference YouTube videos, TikToks, and social posts as sources. A brand with no structured, well-labelled video presence is absent from an entire surface of modern discovery — one that doesn't show up in traditional referral analytics at all.

**As of July 2026, Google Search Console covers social.** Verified Instagram, TikTok, X, and YouTube accounts can now see which Google searches led people to their social posts. If you haven't connected your accounts, do it — it's the only place you'll see the Google-side query data, and this service can't collect it for you.

The through-line: **every platform now matches queries across multiple fields at once** — spoken audio (transcribed), on-screen text, captions, titles, hashtags, and profile metadata. Optimising one field and ignoring the rest leaves most of the ranking signal on the table.

---

## YouTube

The most mature search surface of the four, and the one where optimisation is most measurable.

### Titles

- **Cap at ~60 characters.** Longer gets truncated in results.
- **Primary keyword inside the first 40 characters** — that's where mobile truncates.
- **Specific beats clever.** "5 Ways to Increase Sales" outperforms "Increase Your Sales". Search intent is literal.
- **Shorts want shorter:** 30–40 characters performs best.

### Descriptions

- Primary keyword **in the first two sentences** — that's what's visible before "show more" and what gets weighted.
- **200–300 words** of genuine context. This is also what AI answer engines parse when deciding whether to cite you.
- Don't keyword-stuff. YouTube detects it, and it reads as spam to humans too.

### Chapters

The highest-leverage item on this page and the most commonly skipped.

- One chapter every **1–3 minutes**.
- Titles **3–6 words**, each standing alone — people read them out of context.
- Per YouTube's 2026 creator data, chapter markers **raise average watch time ~11%**.
- Google surfaces chapters directly in web search results, which pulls in traffic from outside YouTube entirely.

### Measure it here

| Signal | Endpoint | What it tells you |
|---|---|---|
| CTR + impressions | `videos/impressions-ctr` | Whether titles and thumbnails earn the click. Low CTR with high impressions = a packaging problem, not a content problem |
| Traffic sources | `traffic-sources`, `traffic-sources/detail` | The **YouTube search** share is your direct SEO scoreboard. Rising = optimisation working |
| Retention | `retention/video` | Whether the content delivers what the title promised. A sharp early drop means the title over-sold |
| Tag performance | `tags/overall`, `tags/country` | Which topics actually pull search traffic, by market |

**The loop:** publish → check CTR after ~48h → if CTR is low, rewrite the title and thumbnail (YouTube re-serves updated metadata to new impressions) → check the search share of traffic sources over the following weeks.

Revisiting older videos with fresh titles, descriptions, and chapters when search trends shift is one of the highest-return activities available, and almost nobody does it.

---

## TikTok

Search behaviour here is fundamentally different from YouTube's, and the difference is worth internalising: **TikTok indexes what it hears and sees, not just what you typed.**

### Keyword placement, in priority order

1. **Say the primary keyword aloud in the first 2–3 seconds.** TikTok transcribes audio and weights it heavily.
2. **Put it on screen as text in those same first seconds.** On-screen text appears to carry weight comparable to spoken audio — and notably *more* than the description.
3. **Caption** — treat it as a mini blog post for the search index, not an afterthought.
4. **Hashtags** — 3–5 focused ones. Hashtag-driven traffic grew 114% year over year, but relevance beats volume; a wall of generic tags dilutes rather than helps.

### Text signals alone won't carry you

TikTok search blends text matching with behavioural signals — watch time, completion rate, saves, shares, comments. A video that matches a query but loses viewers at second three will lose to one that matches less precisely and holds attention. **Optimise for the query *and* the retention; keyword-only optimisation fails here in a way it doesn't on YouTube.**

### Measure it here

| Signal | Endpoint | What it tells you |
|---|---|---|
| Per-video views | `videos/statistics` | The blunt outcome measure |
| Engagement rate | derive: (likes + comments + shares) ÷ views | The real quality signal — raw views are dominated by algorithmic push |
| Follower trend | `account/overview` snapshots | Whether discovery converts to audience |

TikTok's API doesn't expose a search-traffic breakdown the way YouTube does, so you're inferring from outcomes. Practical approach: **change one variable at a time** — a batch of videos with keywords in the first 3 seconds versus a batch without — and compare median views and engagement rate across the two cohorts using the stored snapshots. It's imprecise, but it's the honest read given what the API surfaces.

---

## Meta — Instagram + Facebook

Instagram's search has improved considerably and now indexes far more than hashtags.

### Instagram

- **Keywords in captions matter now**, independently of hashtags. Write for a person searching, not just a tag browser.
- **Fill the profile name field with a keyword**, not only the brand name. It's indexed, and "Brand — Arabic Business News" is searchable in a way "Brand" alone is not.
- **Alt text** is a genuine ranking input and doubles as accessibility. Write it descriptively, not as a keyword dump.
- **Hashtags: 3–5 specific ones.** The 30-tag era is over; it now reads as spam.
- **On-screen text in Reels is indexed** — same principle as TikTok.

### Facebook

Lower search leverage overall, but: descriptive post text beats link-only posts, and Page name and About fields are indexed and worth treating as real metadata rather than boilerplate.

### Measure it here

| Signal | Endpoint | What it tells you |
|---|---|---|
| Tag performance | `tags/overall`, `tags/detail` | Which hashtags correlate with reach — the closest thing Meta gives you to keyword data |
| Reach vs. impressions | `dashboard/overview`, `dashboard/content-table` | Reach growing faster than follower count means discovery is working |
| Geographic reach | `breakdown/geo`, `videos/geo/table` | Whether you're reaching the market you're targeting or an incidental one |
| Per-post detail | `content/detail` | Which specific posts broke out, for pattern-finding |

**Watch reach-from-non-followers as the discovery metric.** Reach that climbs while follower count stays flat is the signature of content winning in search and recommendations rather than just being served to existing followers.

---

## LinkedIn

Different game entirely: lower volume, far higher intent, and the audience *composition* matters more than audience size.

### Company page

- **Keywords in the page tagline and About section** — both indexed by LinkedIn search *and* by Google, which ranks LinkedIn company pages well.
- **Custom button and page URL** should reflect how people search for you.
- Complete every profile field. LinkedIn demonstrably favours completeness in search ranking.

### Posts

- **First two lines are everything** — that's what shows before "see more", and it determines both the click and the search snippet.
- **3–5 hashtags maximum.** LinkedIn hashtags are weaker signals than on Instagram or TikTok; relevance to the professional topic matters more than reach.
- **Native content over external links.** LinkedIn suppresses posts that send people off-platform, so a link-only post is fighting the distribution algorithm before search ever enters the picture.
- **Documents and carousels** get disproportionate reach and are fully indexed.

### Measure it here

| Signal | Endpoint | What it tells you |
|---|---|---|
| Impressions vs. clicks | `shares/statistics` | CTR tells you whether the first two lines are working |
| Engagement rate | `shares/statistics` | LinkedIn's own distribution signal — it compounds |
| **Audience composition** | `followers/statistics` | The one that matters most: industry, function, seniority, company size |
| Page traffic split | `page/statistics` | Desktop/mobile/careers-page breakdown |

**For B2B, reaching the right people beats reaching more people.** Follower demographics by seniority and industry answer whether your content is landing with decision-makers or with job seekers — a distinction raw follower growth completely hides, and the reason the demographics panel deserves prime space in the dashboard.

---

## Cross-platform practices

**One topic, four native executions.** Cross-posting the same file everywhere underperforms on every platform at once. Same subject, formatted for each: YouTube gets depth and chapters, TikTok gets a hook in the first three seconds, Instagram gets visual polish, LinkedIn gets the professional angle.

**Say the keyword out loud in video.** Transcription-based indexing now applies on YouTube, TikTok, and Instagram Reels alike. It's the single highest-leverage habit change across all three.

**Optimise for citation, not just clicks.** When an AI answer engine surfaces your content as a source, that's visibility your referral analytics won't record. Clear titles, real descriptions, structured chapters, and accurate transcripts are what make content citable.

**Build a keyword list per platform, not one shared list.** Search language differs: someone types a different phrase into TikTok than into Google for the same underlying question.

**Re-optimise the back catalogue.** Titles, descriptions, and tags on older content can be updated at any time, and on YouTube especially this is reliably high-return.

**Measure by cohort, not anecdote.** Change one variable across a batch of posts, then compare medians in the stored snapshots. Single-post comparisons are dominated by algorithmic noise and will lead you to confident wrong conclusions.

---

## Sources

- [Social Media SEO Guide: Smarter Visibility Plays for 2026 — SEOProfy](https://seoprofy.com/blog/social-media-seo/)
- [Social Media SEO in 2026: How Search Is Converging — Power Digital](https://powerdigitalmarketing.com/blog/social-media-seo-2026/)
- [YouTube, TikTok, And Instagram As Search Engines — ALM Corp](https://almcorp.com/blog/youtube-tiktok-instagram-social-seo-2026/)
- [YouTube SEO Best Practices (2026) — Learning Revolution](https://www.learningrevolution.net/youtube-seo/)
- [YouTube chapters best practices (2026)](https://chapter-generator.com/blog/youtube-chapters-best-practices)
- [YouTube Best Practices for SEO and LLM Success in 2026 — JCT Growth](https://jctgrowth.com/youtube-seo-and-ai-strategy/)
- [TikTok SEO: The essential guide for brands in 2026 — Sprout Social](https://sproutsocial.com/insights/tiktok-seo/)
- [TikTok SEO Statistics 2026 — Rise at Seven](https://riseatseven.com/blog/tiktok-seo-statistics/)
- [TikTok SEO Guide 2026 — Metricool](https://metricool.com/tiktok-seo/)
- [SEO Trends 2026: SEO Transformation and AI Impact — TheeDigital](https://www.theedigital.com/blog/seo-trends)
