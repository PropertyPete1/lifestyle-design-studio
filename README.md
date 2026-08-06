# Lifestyle Design Studio

Automated social content for Lifestyle Design Realty. Everything runs on GitHub
Actions cron; there is no server. State lives in JSON files committed back to this
repo by the jobs themselves.

Three content pipelines run on their own, plus one that only ever prepares work for
a human. Nothing in this repo publishes to a social account without either a
scheduled job doing it deliberately or Peter approving it first — the YouTube
pipeline in particular **never** publishes.

## The pipelines

| Pipeline | Entry point | Workflow | Schedule (UTC / CT) |
| --- | --- | --- | --- |
| **Daily reels** | `auto-poster/src/main.js` | `post.yml` | 5 slots + a `:30` backup each — SA 16:00/11am, ATX 17:00/12pm, SA 19:00/2pm, ATX 20:00/3pm, DFW 21:00/4pm |
| **Daily carousel** | `auto-poster/src/carousel-main.js` | `post.yml` | 14:00 / 9:00 AM |
| **Weekly YouTube** | `auto-poster/src/yt-brief-main.js`, `yt-pipeline-main.js` | `youtube-longform.yml` | Brief Mon 14:00 (+`:30` backup); pipeline polls 15:00 and 21:00 daily |
| **Trial variant** | `auto-poster/src/trial-variant-main.js` | `post.yml` | 13:15 / 8:15 AM and 23:45 / 6:45 PM |

Every slot has a `:30` backup cron. A slot-aware idempotency guard makes a double
fire safe.

### Daily reels

Per city, per slot: pick a video from that city's Drive folder that has not run
recently, check it is not a duplicate (perceptual hash, then content hash, then AI
vision for the ambiguous band), detect speech and add an ElevenLabs voiceover if the
clip is silent, quality-check it, write a fresh caption with Claude weighted by recent
performance, publish through Metricool to Instagram / TikTok / YouTube Shorts, then
**verify** the post actually reached `PUBLISHED` rather than trusting the 200.

All three cities post daily. (An earlier every-other-day rule for DFW no longer
exists in the code.)

The same job also posts text-only LinkedIn recruiting content, fanned out to three
Metricool brands. That path is decoupled — it runs whether or not the video posted.

### Daily carousel

Writes a slide deck for the day's content pillar, runs it past a critic gate and
regenerates anything scoring under 8/10, renders 1080×1350 slides, assembles a PDF
for LinkedIn, and fans out to the paths that were proven to work: Instagram
satellite accounts, TikTok, Facebook, and LinkedIn as a document.

**Main Instagram is never auto-published.** The deck is delivered to Peter and he
posts it himself. That is deliberate, not a limitation.

### Weekly YouTube

The one pipeline built entirely around waiting for a person.

1. **Monday brief** — proposes three topics and raises an approval card.
2. Peter picks one. The pipeline writes a script and delivers a **recording kit**.
3. Peter records the on-camera takes into a Drive folder.
4. The pipeline ingests them, assembles the video, and uploads it **private**.
5. Peter reviews. Approving records the approval and unlocks the Shorts cutdowns.

**Step 5 does not publish.** Peter flips the video to public himself in YouTube
Studio, where he also sets the two things the Metricool API cannot reach. The
polling job runs twice a day and most runs correctly do nothing.

### Trial variant

Generates one experimental variant of an existing video, twice a day, and delivers
it to Drive + the dashboard + email. **Posts to no social account.**

## What requires a human

| Moment | Who | Why |
| --- | --- | --- |
| YouTube topic pick | Peter | The week's subject is an editorial call |
| YouTube on-camera recording | Peter | He records the takes himself |
| YouTube release to public | Peter | The pipeline uploads private and stops; publishing is manual in Studio |
| Main Instagram carousel | Peter | Delivered to him, never auto-published |
| Trial variants | Peter | Delivered for review, never posted |
| Rotating `GOOGLE_REFRESH_TOKEN` | Peter | `scripts/get-refresh-token.js`, run locally |

## Where state lives

All under `auto-poster/`, all committed by the jobs via `merge-log-push.mjs`, which
merges in JSON-space rather than with git so concurrent runners cannot conflict.
Merge rules are in `merge-strategies.mjs` and unit-tested.

| File | Holds | Growth |
| --- | --- | --- |
| `posted-log.json` | Every post: city, date, video, caption, brands, verification | 365-day window |
| `video-matches.json` | Drive-to-Instagram hash match cache | **uncapped** — ~160KB, watch it |
| `carousel-log.json` | Carousel decks, scores, distribution results | last 120 |
| `yt-approvals.json` | YouTube approval requests and Peter's decisions | last 400 |
| `youtube-log.json` | Rendered / uploaded / reviewed long-form videos | last 200 |
| `trial-variants.json` | Trial variant history | last 100 |
| `linkedin-history.json` | Recent LinkedIn posts, for anti-repetition | last 7 |
| `performance-weights.json` | Hook-style weights from weekly analytics | bounded by style count |
| `qc-blocklist.json` | Drive IDs blocked by quality check | union, never released |
| `skip-list.json` | Drive IDs the owner skipped from the dashboard | union, never released |

`yt-approvals.json` and `youtube-log.json` have **two** writers — this repo's jobs and
the deployed dashboard — so their merges reconcile field-group by field-group. Read
the comments in `merge-strategies.mjs` before touching either: the rules there are
what stop a decision being erased or a video being published twice.

Config, not state: `carousel-brand.json` (palette), `communities.json` (community
knowledge base).

## Workflows

| Workflow | Trigger | Permissions | Does |
| --- | --- | --- | --- |
| `post.yml` | 13 crons + manual | `contents: write` | Reels, carousel, trial variant. **The live posting path.** |
| `youtube-longform.yml` | 4 crons + manual | `contents: write` (dry-run job: `read`) | Weekly brief and pipeline poll |
| `test.yml` | push to main, all PRs | `contents: read` | The test suite |
| `carousel-review.yml` | push to `fix/**`, `feat/**` | `contents: read` | Re-scores past decks, generates samples |
| `verify-dashboard.yml` | push to `fix/**`, `feat/**` | `contents: read` | Replays the carousel delivery webhook |
| `longform-probe.yml` | manual | `contents: read` | Phase 0 capability probes |

Only the two that must commit state hold `contents: write`. Everything else is
read-only, deliberately.

## Scripts

- `auto-poster/scripts/` — scripts a workflow still invokes, plus
  `get-refresh-token.js` for credential rotation.
- `auto-poster/scripts/archive/` — one-time scripts that already did their job, kept
  as the record of why the live constants are what they are.
  [Archive README](auto-poster/scripts/archive/README.md).
- `longform/probe/` — Phase 0 YouTube capability probes (issue #19).

### Scripts that touch live systems

Anything that can reach a live account, the Metricool media library, the dashboard,
a committed state file, or a real credential **refuses to run** unless you set:

```
I_UNDERSTAND_THIS_TOUCHES_LIVE=yes
```

Each one names what it touches when it refuses. See
[`auto-poster/scripts/live-guard.mjs`](auto-poster/scripts/live-guard.mjs). This
exists because two scripts did exactly what their headers said, run by someone who
had not read the header: a public TikTok post that could not be retracted, and a file
left orphaned in the Metricool media library.

## Tests

```bash
cd auto-poster && npm test
```

728 tests, `node --test`, no framework. They run on every PR. The poster publishes to
live accounts on a cron, so a regression in the duplicate guards or the caption safety
rules is a business incident rather than a failed build — treat a red suite that way.

## Secrets

| Secret | Used for |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | Drive read/write, Gmail send |
| `METRICOOL_API_TOKEN` / `METRICOOL_BLOG_ID` / `METRICOOL_USER_ID` | Publishing and analytics |
| `ANTHROPIC_API_KEY` | Captions, decks, scripts, AI vision |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | Voice clone TTS |
| `DASHBOARD_URL` / `DASHBOARD_WEBHOOK_SECRET` | Delivery and approval webhooks |
| `YT_TEXT_NUMBER` / `YT_LINKS_URL` | YouTube CTA copy |

Optional: `LINKEDIN_BLOG_ID_PETER`, `LINKEDIN_BLOG_ID_STEVEN`,
`LINKEDIN_BLOG_ID_LIFESTYLE` override the LinkedIn fan-out targets; the shipped
defaults are the current accounts.

**The Google OAuth app must be in Production, not Testing** — a Testing app expires
its refresh token after 7 days.

## Costs

Roughly $5–8/month: ~$0.02/post for Claude, ~$0.05 for ElevenLabs when a clip needs a
voiceover, and GitHub Actions within the free tier.

## Operator detail

`auto-poster/README.md` has the per-city Drive folder IDs, the match-distance
thresholds, rotation rules, and the troubleshooting table.
