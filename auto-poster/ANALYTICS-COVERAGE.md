# Metricool analytics coverage

What this account's Metricool plan actually exposes, what the collector reads,
and what it deliberately does not — with the evidence.

Everything below was measured, not read off documentation. Re-run it with:

```bash
node scripts/probe-social-analytics.mjs
```

(or the **Social Analytics Probe** workflow, which supplies the credentials).
Last run against the live account: **2026-08-12**.

Metricool's published command reference does not list `youtube` as a valid
network for post analytics. On this account it works and returns 234 rows. That
is the reason this file exists: the docs are not a reliable guide to what the
API will give you, so the probe is the source of truth and this is its report.

---

## Collected

| Endpoint | Platform | Live rows | Metrics taken |
|---|---|---|---|
| `/v2/analytics/reels/instagram` | `instagram` | 296 across 4 brands | views, reach, impressions, likes, comments, shares, **saves**, interactions, engagement, avg watch, duration, skip rate |
| `/v2/analytics/posts/instagram` | `instagram` | 24 across 4 brands | same vocabulary, for non-reel feed posts |
| `/v2/analytics/posts/tiktok` | `tiktok` | 92 | views, likes, comments, shares, engagement, duration |
| `/v2/analytics/posts/youtube` | `youtube_shorts` | 98 of 234 | views, likes, comments, shares, watch minutes, avg watch, duration |

**Instagram needs both endpoints.** `reels` and `posts` are disjoint — 46 reels
and 1 feed carousel on the main brand over the same window, no overlap. Reading
only one silently drops a whole content type.

**All four brands are collected.** The poster fans one video out to every
connected brand, so the same reel genuinely exists on four Instagram accounts
with four different view counts. Row identity is `(platform, account, post_id)`;
keying on `post_id` alone would dedupe three real publications away, which is
the bug `social-telemetry.js` documents having already been bitten by once.

**YouTube is Shorts-only, and narrower than the channel.** Metricool marks
Shorts with `videoType: "SHORT"`, but that key is present on only 98 of 234
rows. A row with no `videoType` is a row whose format is unknown — not a row
that is known not to be a Short — so it is excluded and *counted*. The count
ships in the file as `unclassified_rows` (136 at last run) so a reader can see
the series is narrower than the channel rather than assuming it is complete.

---

## Not collected, and why

### Follower count and delta — the one that looks available

Issue #83 asks for these. They cannot be had on this tier, and the failure mode
is the dangerous kind: **the obvious implementation returns HTTP 200.**

```
GET /stats/timeline/followers      → 200  [["20260812","0"]]
GET /stats/timeline/Community      → 200  [["20260812","0"]]
GET /stats/timeline/fans           → 200  [["20260812","0"]]
GET /stats/timeline/subscribers    → 200  [["20260812","0"]]
GET /stats/timeline/shares         → 200  [["20260812","0"]]
GET /stats/timeline/communityDaily → 200  [["20260812","0"]]
```

Byte-identical, for every metric name tried — including ones invented on the
spot to test exactly this. That endpoint acknowledges a request; it does not
report a number. `/stats/aggregation/<metric>` behaves the same way, answering
the scalar `0` regardless of what you ask for.

Every alternative route is closed:

| Route | Result |
|---|---|
| `/v2/analytics/{instagram,tiktok,youtube,facebook}/profile` | 404 — the endpoint does not exist |
| `/stats/{network}/timeline/followers`, `/stats/timeline/{network}/followers` | 404 |
| `/v2/analytics/timelines/...` (three spellings) | 404 |
| `/stats/timeline/followers?network=instagram` | 200, same stub — the param is ignored |
| `/admin/simpleProfiles` | 89 keys, **none** follower-related |
| `/v2/analytics/competitors/{network}` | `{"data":[]}` — no competitors configured |

Had the collector read that 200, it would publish `followers: 0` for every
platform every day: a dashboard asserting the accounts have no audience and are
not growing. The metric is omitted, and the omission is recorded **inside**
`status/social_analytics.json` under `unavailable[]` so the dashboard can render
"not available" instead of a flat line through zero.

### Saves on TikTok and YouTube

No saves-equivalent field exists in either response. Instagram reports it as
`saved` and it is collected there. Mapping the others to `0` would claim nobody
ever saved a TikTok.

### Reach on TikTok and YouTube

No reach field in either response. Instagram reports reach separately from views
and it is collected there.

### Facebook

`/v2/analytics/posts/facebook` and `/v2/analytics/reels/facebook` return 403
*"There is no facebook connection for blog"*. Facebook is also outside the
dashboard's three-platform contract.

### Instagram Stories

`/stats/instagram/stories` answers 200 but returned no rows in a 30-day window,
so its field shapes are unconfirmed. Not collected — an endpoint that has never
returned a row is not a thing to build on.

### TikTok `impressionSources`

Present on all 92 rows and null in every sub-field
(`forYou`, `follow`, `hashtag`, `sound`, `search`, `personalProfile`).
Structurally there, semantically empty.

---

## The rule this file serves

From `src/social-telemetry.js`, and inherited wholesale:

> A key that is PRESENT is a measured fact. A key that is ABSENT is "we do not
> know". Zero means the API reported zero. Those three states are not
> interchangeable.

An analytics API makes this harder than a log file does, because it answers 200
far more often than it answers usefully. Hence the shape of the probe: it grades
every field by `present` / `nonNull` / `nonZero` across a month of real posts,
so a field that exists but is never populated is visible as such rather than
arriving as a column of confident zeros.

## Degradation

- One endpoint failing degrades **that platform on that brand** and nothing else;
  the platform block gets `partial: true` and a `failures[]` with the reason.
- Every source for a platform failing gives that platform `unavailable` and no
  freshly computed series — an empty series would read as "we looked and there
  was nothing". Days it had already measured are kept, because they are still
  facts; `unavailable` is what marks them stale.
- Every source failing at once leaves the previous file **untouched** and exits
  0. A stale `generated_at` is the truth; an empty file is not.
- The writer never throws. It runs in a scheduled commit step, and a dashboard
  number is never worth failing a run over.

## History, and why the daily series is merged rather than recomputed

`recent_posts` is capped at 750 rows, which at this volume is roughly six weeks.
`daily` is therefore **not** simply recomputed from it on each run: months later
a recompute would find only a handful of the posts that were once on an old day
and would quietly rewrite that day from 20 posts to 5 — a measured number
shrinking after the fact with nothing to explain it.

The merge rule follows where the better information is:

| Date | Authority | Why |
|---|---|---|
| inside the 30-day fetch window | the fresh row | every post is re-read from the API each run, so it is complete, and metrics are still moving |
| older than the window | the stored row | the fresh row is only whatever survived trimming |

A fresh row for an old date with nothing stored against it is still taken — that
is a first sighting, not a contradiction.

`posts_recorded` counts every post record on file for a platform. It is
deliberately not called `posts_in_window`, because as history accumulates it
stops being one.
