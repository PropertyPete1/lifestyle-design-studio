# Lifestyle Design Realty — Daily Reels System

Automated social media posting pipeline for real estate video content across San Antonio, Austin, and Dallas/DFW.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Manus Heartbeat Cron (3 jobs: SA, ATX, DFW)            │
│  Fires at 2 PM / 3 PM / 4 PM CT daily                  │
└──────────────────────┬──────────────────────────────────┘
                       │ POST /api/scheduled/triggerAutoPost
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Deployed Dashboard (server/ + client/)                  │
│  • Calls GitHub API (workflow_dispatch)                  │
│  • Also serves: pick generation, analyst, library UI    │
└──────────────────────┬──────────────────────────────────┘
                       │ GitHub Actions workflow_dispatch
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Auto-Poster (auto-poster/)                             │
│  Runs on GitHub Actions ubuntu-latest                   │
│  • Drive → download video                              │
│  • Whisper → speech detection                          │
│  • ElevenLabs → voiceover (if no speech)               │
│  • Claude → caption generation (weighted by analytics) │
│  • Metricool → post to IG/TikTok/YouTube/FB            │
│  • Verify → confirm PUBLISHED status                   │
└─────────────────────────────────────────────────────────┘
```

## Directory Structure

```
auto-poster/          ← The posting pipeline (GitHub Actions)
  src/                  Core modules (main, drive, metricool, matcher, etc.)
  scripts/              Utility scripts (speech detection, token refresh)
  .github/workflows/    Workflow definition (post.yml)

server/               ← Dashboard backend (tRPC + Express)
  _core/                Framework plumbing (auth, heartbeat, LLM, storage)
  scheduledPublish.ts   Legacy publish endpoints (still used for picks/analyst)
  routers.ts            tRPC API routes

client/               ← Dashboard frontend (React + Tailwind)
  src/pages/            UI pages (Home, Library, History, Performance)

drizzle/              ← Database schema + migrations
references/           ← Architecture docs (voiceover, periodic-updates)
```

## Key Data Files (auto-poster/)

| File | Purpose |
|------|---------|
| `posted-log.json` | Record of every post (city, date, video, brands, verification) |
| `video-matches.json` | Cache of Drive→IG hash matches (prevents re-posting) |
| `performance-weights.json` | Hook style weights from weekly analytics |

## Matching & Safety

- **Perceptual hash** (8×8 grayscale average) compares Drive videos to recent IG posts
- **Distance 0-4**: auto-block + auto-reuse caption
- **Distance 5-9**: AI vision confirmation required before caption reuse
- **Distance 10-17**: AI vision confirmation required before blocking
- **Distance 18+**: no match, safe to post
- **City keyword check**: prevents cross-city caption reuse

## Legacy Archive

One-off scripts and planning notes from development are preserved in the `legacy-archive` branch.
