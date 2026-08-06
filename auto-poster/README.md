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
4. Detect speech (Whisper); if the clip is silent, generate an ElevenLabs voiceover
5. Quality check — resolution, duration, file size, audio
6. Write a fresh caption with Claude, weighted by `performance-weights.json`
7. Publish through Metricool to Instagram, TikTok, YouTube Shorts
8. Wait ~7 minutes and confirm `PUBLISHED`; exit non-zero if it did not
9. Append to `posted-log.json` and push it back with `merge-log-push.mjs`

## Schedule

| City | Slots (CT) |
| --- | --- |
| San Antonio | 11:00 AM, 2:00 PM |
| Austin | 12:00 PM, 3:00 PM |
| Dallas / DFW | 4:00 PM |

All three post **daily**. Each slot has a `:30` backup cron; the slot-aware
idempotency guard makes a double fire safe.

Carousel runs at 9:00 AM CT. Trial variants at 8:15 AM and 6:45 PM CT.

## Manual trigger

**Actions → Daily Auto Post → Run workflow.** Pick a city and a slot, plus:

| Input | Effect |
| --- | --- |
| `dry_run` | Full pipeline, publishes nothing |
| `force` | Bypasses the content-duplicate guard. (It does **not** bypass any cadence rule — there is no longer one to bypass.) |
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

## Data files

See the state table in the [root README](../README.md#where-state-lives) for what
each file holds and how its growth is bounded.
