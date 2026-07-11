# Auto Poster

Fully automated social media posting pipeline. Runs on GitHub Actions, triggered by Manus Heartbeat cron jobs that call GitHub's API directly.

## What It Does

Every day, per city:

1. **Checks Instagram** (via Metricool) for posts in the last 30 days
2. **Picks a video from Google Drive** that hasn't been posted recently (30-day rotation)
3. **Duplicate check** — perceptual hash + AI vision confirmation prevents reposts
4. **Detects speech** (Whisper) — if no talking, generates and adds a voiceover (ElevenLabs)
5. **Quality check** — validates resolution, duration, file size, audio
6. **Generates a fresh caption** using AI (Claude) with performance-weighted hook styles
7. **Posts to all platforms** via Metricool: Instagram, TikTok, YouTube Shorts
8. **Verifies** — waits 7 min, confirms PUBLISHED status; exits non-zero on failure
9. **Logs the result** to `posted-log.json` (committed back to the repo)

## Schedule

| City | Time (CT) | Frequency |
|------|-----------|-----------|
| San Antonio | 2:00 PM | Daily |
| Austin | 3:00 PM | Daily |
| Dallas/DFW | 4:00 PM | Every other day |

## Manual Trigger

Go to **Actions > Daily Auto Post > Run workflow**:
- Select city
- **Force** — bypasses DFW every-other-day check
- **Dry run** — full pipeline without actually posting

## Matching & Safety

| Distance | Behavior |
|----------|----------|
| 0-4 | Auto-block + auto-reuse caption |
| 5-9 | AI vision confirmation required before caption reuse |
| 10-17 | AI vision confirmation required before blocking |
| 18+ | No match, safe to post |

City keyword check prevents cross-city caption reuse.

## Key Data Files

| File | Purpose |
|------|---------|
| `posted-log.json` | Record of every post (city, date, video, brands, verification) |
| `video-matches.json` | Cache of Drive-to-IG hash matches (prevents re-posting) |
| `performance-weights.json` | Hook style weights from weekly analytics |

## Secrets Required

| Secret | Description |
|--------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret |
| `GOOGLE_REFRESH_TOKEN` | Google Drive refresh token |
| `METRICOOL_API_TOKEN` | Metricool API token |
| `METRICOOL_BLOG_ID` | Metricool blog/brand ID |
| `METRICOOL_USER_ID` | Metricool user ID |
| `ELEVENLABS_API_KEY` | ElevenLabs API key for voiceovers |
| `ANTHROPIC_API_KEY` | Anthropic API key for vision + captions |

## Drive Folder Structure

| City | Folder |
|------|--------|
| San Antonio | San Antonio New (`1O5lL5rWjuzj3kg5kRMqY7E4CdcnDz4bY`) |
| Austin | Austin New (`1GgKKUJFzV39JQ3oTRoe7aTdZwqqMbba8`) |
| Dallas/DFW | DFW New (`1nNrGjhHeMG3B25Cj3o7T2cLRAJM-9RX2`) |

To change folder IDs, edit `src/drive.js` > `CITY_FOLDER_IDS`.

## How Rotation Works

- Each city's Drive folder contains all available videos
- `posted-log.json` tracks which videos were posted and when
- A video becomes eligible again after 30 days
- If a video fails to download, the system tries the next candidate (up to 3)
- 20-hour idempotency guard prevents double-posting if cron fires twice

## Google Cloud App Status (CRITICAL)

Your Google OAuth app **must be in "Production" mode** (not "Testing"):
- Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials/consent)
- Publishing status should say **"In production"**
- If "Testing", click "Publish App" — otherwise refresh token expires in 7 days

## Costs

- **Anthropic (Claude)**: ~$0.02/post (vision + captions)
- **ElevenLabs**: ~$0.05/post (only when video needs voiceover)
- **GitHub Actions**: Free (runs ~3-7 min per post, well within free tier)
- **Total**: ~$5-8/month for all 3 cities

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "No Google Drive token" | Refresh token expired — re-run `scripts/get-refresh-token.js` |
| "All videos posted in 30 days" | Add more videos to the Drive folder |
| "Metricool upload failed" | Check API token is valid at app.metricool.com |
| Double-posted | 20-hour guard should prevent; check `posted-log.json` |
| DFW posting daily | Check FORCE isn't set; verify day-of-year logic |
| Verification failed (red X) | Check GitHub notification email; post may have been rejected by platform |
