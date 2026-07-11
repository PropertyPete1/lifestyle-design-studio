# Lifestyle Design Realty — Auto Poster

Automated daily Instagram/TikTok/YouTube Shorts posting pipeline for Lifestyle Design Realty.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Manus Heartbeat Cron (3 jobs: SA, ATX, DFW)            │
│  Fires at 2 PM / 3 PM / 4 PM CT daily                  │
└──────────────────────┬──────────────────────────────────┘
                       │ POST /api/scheduled/triggerAutoPost
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Deployed Dashboard (separate Manus webdev project)     │
│  • Calls GitHub API (workflow_dispatch)                  │
│  • Also serves: pick generation, analyst, library UI    │
└──────────────────────┬──────────────────────────────────┘
                       │ GitHub Actions workflow_dispatch
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Auto-Poster (this repo: auto-poster/)                  │
│  Runs on GitHub Actions ubuntu-latest                   │
│  • Drive → download video                              │
│  • Whisper → speech detection                          │
│  • ElevenLabs → voiceover (if no speech)               │
│  • Claude → caption generation (weighted by analytics) │
│  • Metricool → post to IG/TikTok/YouTube/FB            │
│  • Verify → confirm PUBLISHED status                   │
└─────────────────────────────────────────────────────────┘
```

## Repo Structure

```
.github/workflows/post.yml    ← GitHub Actions cron + manual dispatch
auto-poster/
├── src/
│   ├── main.js               ← Entry point + orchestration
│   ├── drive.js              ← Google Drive video download
│   ├── matcher.js            ← Perceptual hashing + AI vision comparison
│   ├── voiceover.js          ← Speech detection + ElevenLabs TTS + ffmpeg merge
│   ├── caption.js            ← AI caption generation with hook optimization
│   ├── metricool.js          ← Metricool API (post + verify)
│   ├── analytics.js          ← Weekly performance feedback loop
│   ├── quality-check.js      ← Pre-post video validation
│   ├── speech-detect.js      ← Whisper-based speech detection
│   └── state.js              ← posted-log.json management
├── scripts/
│   └── detect-speech.py      ← Python Whisper wrapper
├── posted-log.json           ← Post history (committed by bot)
├── video-matches.json        ← Hash match cache
└── performance-weights.json  ← Hook style weights (auto-updated weekly)
```

## Cities & Schedule

| City | Cron (UTC) | CT Time | Frequency |
|------|-----------|---------|-----------|
| San Antonio | 19:00 | 2:00 PM | Daily |
| Austin | 20:00 | 3:00 PM | Daily |
| Dallas/DFW | 21:00 | 4:00 PM | Every other day |

## Manual Dispatch

Go to **Actions → Daily Auto Post → Run workflow**. Select city, optionally check:
- **Force** — bypasses DFW every-other-day check
- **Dry run** — runs full pipeline without actually posting

## Matching & Safety

- **Perceptual hash** (8x8 grayscale average) compares Drive videos to recent IG posts
- **Distance 0-4**: auto-block + auto-reuse caption
- **Distance 5-9**: AI vision confirmation required before caption reuse
- **Distance 10-17**: AI vision confirmation required before blocking
- **Distance 18+**: no match, safe to post
- **City keyword check**: prevents cross-city caption reuse

## Secrets Required

| Secret | Purpose |
|--------|---------|
| `GOOGLE_CLIENT_ID` | Drive API OAuth |
| `GOOGLE_CLIENT_SECRET` | Drive API OAuth |
| `GOOGLE_REFRESH_TOKEN` | Drive API OAuth |
| `METRICOOL_API_TOKEN` | Metricool posting + analytics |
| `METRICOOL_BLOG_ID` | Metricool brand identifier |
| `METRICOOL_USER_ID` | Metricool user identifier |
| `ELEVENLABS_API_KEY` | Voice clone TTS |
| `ANTHROPIC_API_KEY` | AI vision + caption generation |

## Related

- **Dashboard** (deployed separately via Manus): manages picks, analytics, and triggers this workflow via Heartbeat cron jobs
- **Legacy code**: archived on `legacy-archive` branch
