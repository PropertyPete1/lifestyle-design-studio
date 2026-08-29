# The learning loop

The pipeline used to generate with no feedback: a hook style was picked by
weighted random *inside* the caption builder and thrown away, so nothing could
ever map a post's performance back to a decision. This closes the loop, in
three parts, against the analytics this account can actually measure.

## What this repo's API access actually is

There is **no Instagram Graph API access and no direct TikTok API access** in
this repo. All posting *and* analytics run through Metricool
(`METRICOOL_API_TOKEN` / `METRICOOL_USER_ID` / `METRICOOL_BLOG_ID`). What the
Metricool tier exposes was **measured, not assumed** — see
[ANALYTICS-COVERAGE.md](ANALYTICS-COVERAGE.md):

| | views | reach | likes | comments | shares | saves | avg watch | skip rate |
|---|---|---|---|---|---|---|---|---|
| Instagram (reels + posts) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| TikTok | ✓ | absent | ✓ | ✓ | ✓ | absent | absent | absent |
| YouTube Shorts | ✓ | absent | ✓ | ✓ | ✓ | absent | ✓ | absent |

**Follows-from-post is unavailable on every platform** — Metricool's follower
endpoints answer 200 with a stub zero for any metric name, which is worse than
a 404. Absent metrics ship as `unavailable[]`, never as zeros
(honest-data doctrine, inherited from `social-telemetry.js`).

Ingestion itself already existed: the **Social Analytics** workflow pulls
per-post metrics nightly (14:00 UTC) into `status/social_analytics.json`,
per platform per account. The learning loop builds on it rather than beside it.

## 1. Tagged variation (`src/variation.js`, `src/hook-styles.js`)

Every post's generation decisions are chosen up front and written onto its
`posted-log.json` entry as `generation`:

- **Hook style** — rotated across six canonical styles (`question`,
  `bold_claim`, `pov`, `stat`, `story_open`, `pattern_interrupt`). **No two
  consecutive posts share a style** (account-level: every city fans out to the
  same accounts). The stat style may only use numbers the video's own facts
  supply — the honesty gates are upstream of style.
- **Caption length** — rotated across short / medium / long buckets, fresh
  captions only (a restructured caption preserves the original's facts and is
  tagged `restructured`, excluded from the length experiment).
- **Hook plate** (`src/reel-hook-burn.js`) — the caption's hook line is also
  burned onto the video's first 3 seconds, using the trial path's plate
  renderer at the source's own dimensions. Same words, second surface — the
  honesty story is unchanged. Gated: a source with burned-in text (or an
  unverifiable caption scan) gets no plate, an unfit line (>12 words, or
  emoji-only) gets no plate, and the burn self-checks its output before
  claiming success. The outcome is tagged (`hook_plate`,
  `generation.hook_plate_burned`) and analyzed in the brief — analyzed-only,
  because eligibility is decided by the source, not rotated.
- **Tagged but not rotated** (stated so the data is honest): posting time
  (the cron owns the slots; slot is recorded and analyzed), topic signals
  (price overlay present, community-KB match — observed, not synthesized),
  voice persona (already rotated by `voiceover.js`, already on the entry).

## 2. The learn step (`src/learn.js`, weekly `learning-loop.yml`)

Mondays 15:30 UTC, after the morning analytics collection:

- **Join**: analytics rows ↔ posted-log entries, by caption first line
  (normalized prefix match) AND publication time within 4 days; each row joins
  at most one entry. Unjoined posts are reported, never scored as zero.
- **Score**: `(views + weighted engagement) × retention factor`. The retention
  factor (0.5×–2.0×) applies only when avg-watch AND duration are both
  present; an absent metric contributes nothing and is named in `missing`.
  A post's headline score is the **median across its Instagram accounts**;
  TikTok/YouTube are reported per platform, never blended (different scales).
- **Rank**: an axis value needs ≥3 posts to be ranked at all
  (`insufficient_sample` below that — visible, never crowned, never killed).
  With enough data: **kill** when its mean is below 0.5× the median of ranked
  values, **winner** for the top value. Only controlled axes (hook style,
  caption length) can produce kill-list entries.
- **Brief**: written per brand to `learning/brief-<brand>.json` and emailed
  as one page (`[WEEKLY BRIEF]`) — top hooks verbatim, winners, the kill
  list, sample-size caveats stated plainly, and the unavailable-metrics list
  carried forward.

## 3. Generation reads the brief

`planVariation()` (called by `main.js` before any caption is written):

- **70%** of picks lean into the brief's winners, weighted by measured score;
- **30%** explore uniformly across everything not on the kill list —
  including under-sampled styles, because exploration is what fixes an
  insufficient sample;
- kill-listed values are never picked (unless the kill list swallows every
  style, in which case it is ignored with a loud warning — an over-aggressive
  scorer must not silence generation);
- no brief, or a brief older than 14 days → fall back to the legacy
  `performance-weights.json` (its five styles mapped onto the canonical six),
  then to uniform. **The pick never fails a posting run.**

## Per-brand by construction

Briefs are keyed by brand (`learning/brief-lifestyle.json` today). A future
brand (the LDT accounts) gets its own brief file and learns only from its own
posts — `BRANDS` in `scripts/run-learning-loop.mjs` is the roster.

## Legacy mapping

History classified by the old five-style regexes maps onto the canonical six
(`vibe→pov`, `wait_tease→pattern_interrupt`, `reaction→story_open`). Posts
that predate tagging carry provenance `inferred` and the brief counts them
separately from `tagged` posts — an inferred grouping is a judgment, not a
measurement.
