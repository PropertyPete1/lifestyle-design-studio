# Auto Poster — operator detail

Per-pipeline reference: folder IDs, thresholds, rotation rules, troubleshooting.
For what the system is and how the pieces fit together, start at the
[root README](../README.md).

Everything here runs from `post.yml` and `youtube-longform.yml` on GitHub Actions
cron. There is no external trigger — an earlier design had a Manus Heartbeat cron
calling the GitHub API, and that is no longer how any of it fires.

## Daily reels — what a run does

1. Read Instagram's last 30 days through Metricool
2. Pick a Drive video for the city that is outside the 30-day rotation
3. Duplicate check — perceptual hash, content hash, AI vision for the ambiguous band
4. Detect speech (Whisper); if the clip is silent or music-only, generate an
   ElevenLabs voiceover — the source-respect gates (`src/source-respect.js`)
   refuse to voice over a clip where someone is talking, refuse a second
   caption layer over burned-in captions, and block any generated figure the
   source doesn't say or show (sweep: `scripts/sweep-source-respect.mjs`)
5. Quality check — resolution, duration, file size, audio
6. Write a fresh caption with Claude, weighted by `performance-weights.json`
7. Publish through Metricool to Instagram, TikTok, YouTube Shorts
8. Wait ~7 minutes and confirm `PUBLISHED`; exit non-zero if it did not
9. Append to `posted-log.json` and push it back with `merge-log-push.mjs`

## Schedule — one reel a day, one market a day (since 2026-09-24)

| What | When (CT) | Cron (UTC) |
| --- | --- | --- |
| The daily reel | 12:45 PM during CDT, 11:45 AM during CST (+ a 30-minute backup) | `45 17 * * *`, `15 18 * * *` |
| Trial variant (posts nowhere) | 8:15 AM, 6:45 PM | `15 13 * * *`, `45 23 * * *` |

**Which market.** San Antonio → Austin → Dallas, by Chicago calendar date, anchored
2026-09-24 = San Antonio (`MARKET_ROTATION_ANCHOR` in `src/cadence.js`) — unless the
day's decision file names a market in its `today` block, in which case that market
takes the day. The calendar owns the sequence: a named Tuesday does not shift
Wednesday. `scripts/market-today.mjs` resolves this for the workflow before
`main.js` runs; `main.js` resolves it again and its gate refuses a mismatch.

**Why 12:45 PM.** The decision task that names the market and video runs daily at
11:00 AM CT (Central time, so it moves with DST while GitHub's UTC crons do not).
17:45 UTC is after it in both regimes — 45 minutes clear in winter — and inside the
11am–1pm CT band Metricool rates best for the account. A reader that fires alongside
the writer would read yesterday's file about half the time.

**The gate is the law** (`cadenceGate` in `src/cadence.js`). Whatever starts a run —
the cron, the Actions tab, or the external dispatcher that still fires the retired
city slots several times a day — only today's market, on the `am` slot, with the
day's single publish unspent, gets past it. Anything else exits clean having posted
nothing; a dispatch standing down is an annotation on the run, the *scheduled* slot
standing down is a `[DAILY ALERT]` mail, because that means nothing posts today.

The retired city crons (SA 16:00/16:30, ATX 17:00/17:30, SA 19:00/19:30, ATX
20:00/20:30, DFW 21:00/21:30) are kept commented in `post.yml`. Restoring one also
needs the gate's law relaxed, or the restored slot stands down every day.

The carousel no longer runs on a schedule — it was retired 2026-09-04 and is manual
dispatch only (`city=carousel`); its 9:00 AM CT cron is kept commented in
`post.yml` for whoever restores it.

## Cadence

`cadence.json` holds the daily cap: **target 1, floor 1, ceiling 2** since
2026-09-24 (an `actor: "operator"` history entry — Instagram rate-limiting — not a
loop step; the code defaults in `src/cadence.js` match it so a corrupt file cannot
reopen 2/day). The loop in `main.js` Step 0b may move the target one step per
14 days toward the decision file's `how_many.posts_per_day`, within the floor and
ceiling, and records every hold. Every change is also appended to
`status/posting_cadence.json` for PRIMARY to read.

## Decision file — today's market and video

The scheduled decision task writes `ig_posting_decision_latest.json` to the
"Ready to Post" folder daily at 11:00 AM CT. Besides `how_many` and
`hooks_that_work`, it may carry a `today` block:

```json
"today": {
  "date": "2026-09-25",
  "market": "austin",
  "drive_file_id": "1abc…",
  "reason": "optional — carried into the run log"
}
```

- `date` is the Chicago calendar day the block is for. It **must equal today** or
  the block is ignored; a block with no date is scoped by the file's Drive
  modifiedTime instead (written today = honoured). Yesterday's file never names
  today's market or video.
- `market` accepts `san_antonio` / `austin` / `dallas`, the plain city names, or
  `SA` / `ATX` / `DFW`. An unrecognised name is refused and the rotation decides.
- `drive_file_id` is the one video. It goes to the head of the ranked queue and is
  still subject to every Step 3 filter (30-day rule, blocklist, skip list, the
  right city's folder) — advice, not law. `safe_to_act: false` suppresses it, as
  it suppresses `post[]`; the market is honoured regardless, as `how_many` is.

The reader is `readTodayBlock` in `src/drive-decision.js`; every run's Step 0 says
what the block did and why.

## Manual trigger

**Actions → Daily Auto Post → Run workflow.** Pick a city and a slot, plus:

| Input | Effect |
| --- | --- |
| `dry_run` | Full pipeline, publishes nothing |
| `force` | Bypasses the content-duplicate guard. It does **not** bypass the cadence gate: only today's market, on the `am` slot, with the day's publish unspent, can post. |
| `test_delivery_only` | Real Drive upload + email + dashboard, zero social posts |
| `force_video_id` | Pin a specific Drive file, skipping rotation and filtering |

## Matching & safety

| Hash distance | Behaviour |
| --- | --- |
| 0–4 | Auto-block, auto-reuse caption |
| 5–9 | AI vision confirmation before caption reuse |
| 10–17 | AI vision confirmation before blocking |
| 18+ | No match, safe to post |

A city keyword check prevents cross-city caption reuse. A separate content hash
catches the same footage re-encoded or re-uploaded — added after a San Antonio video
reposted on 2026-07-31 under a different file name. The threshold was chosen
empirically; see `scripts/archive/calibrate-content-hash.mjs`.

## Drive folders

| City | Folder | ID |
| --- | --- | --- |
| San Antonio | San Antonio New | `1O5lL5rWjuzj3kg5kRMqY7E4CdcnDz4bY` |
| Austin | Austin New | `1GgKKUJFzV39JQ3oTRoe7aTdZwqqMbba8` |
| Dallas / DFW | DFW New | `1nNrGjhHeMG3B25Cj3o7T2cLRAJM-9RX2` |

To change these, edit `CITY_FOLDER_IDS` in `src/drive.js`.

## Rotation

- Each city folder holds every available video for that city
- `posted-log.json` records what was posted and when
- A video becomes eligible again after 30 days
- A failed download falls through to the next candidate, up to 3
- A 20-hour idempotency guard prevents a double post if cron fires twice

## Google Cloud app status

The OAuth app **must be in Production**, not Testing —
[console](https://console.cloud.google.com/apis/credentials/consent). A Testing app
expires its refresh token after 7 days. Publishing status should read
"In production".

Rotating the token: `I_UNDERSTAND_THIS_TOUCHES_LIVE=yes node scripts/get-refresh-token.js`,
run locally, then paste into `GOOGLE_REFRESH_TOKEN`. Replacing that secret
invalidates the token every scheduled job is currently using.

## Costs

| | |
| --- | --- |
| Anthropic (Claude) | ~$0.02 per post — vision + captions |
| ElevenLabs | ~$0.05 per post, only when a clip needs a voiceover |
| GitHub Actions | Free — 3–7 min per post, inside the free tier |
| **Total** | **~$5–8/month** across all three cities |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No Google Drive token" | Refresh token expired — re-run `scripts/get-refresh-token.js` and check the app is in Production |
| "All videos posted in 30 days" | Add more videos to that city's Drive folder |
| "Metricool upload failed" | Check the token at app.metricool.com |
| Double-posted | The 20-hour guard should prevent it; check `posted-log.json` |
| Verification failed (red X) | Check the GitHub notification email — the platform may have rejected the post |
| A carousel logged success but nothing appeared | The scheduler returning 200 means *accepted*, not published. That is why step 8 verifies; TikTok hit exactly this on 2026-08-03 |
| A script refuses to start | It touches a live system. Read what it prints, then set `I_UNDERSTAND_THIS_TOUCHES_LIVE=yes` if you mean it |
| A run "stood down at the cadence gate" | Working as designed: not today's market, the retired `pm` slot, or the day's one publish already made. The `[Step 0b]` lines name today's market and why. If it was the *scheduled* slot, compare the `[MarketToday]` lines of the market step with `[Step 0]` — they read the same decision file and must agree |

## Data files

See the state table in the [root README](../README.md#where-state-lives) for what
each file holds and how its growth is bounded.
