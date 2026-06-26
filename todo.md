# Lifestyle Design Realty — Daily Reels Dashboard TODO

## Data Layer
- [x] Define DB schema: videos (library), reposts (history), daily_picks, app_settings
- [x] Generate + apply migration via webdev_execute_sql
- [x] Import ranked + city-classified video library (107: 20 Austin / 87 SA) into DB
- [x] DB helpers in server/db.ts for videos, reposts, daily picks
- [x] Stable hosted thumbnails (cover frames uploaded to static storage)

## Backend / Selection Engine
- [x] Selection logic: top IG views per city, 30-day no-repeat cooldown, auto next-best fallback
- [x] AI caption refresh procedure (opening lines only; CTA + hashtags preserved)
- [x] Generate today's two picks (Austin + SA) on demand / idempotent per day
- [x] Confirm-to-post procedure: records confirmation, schedules 2PM & 3PM CDT, writes repost history
- [x] Owner-only access enforced (adminProcedure / owner openId)

## Frontend
- [x] Daily Picks dashboard: two cards (Austin, SA) with thumbnail, views, city label, schedule
- [x] Editable caption field per pick (shows AI-refreshed caption)
- [x] One-tap Confirm button per Reel + Save edits + Regenerate
- [x] Post status indicator: pending / confirmed / posted / failed
- [x] Rotation history log page (date, city, thumbnail, views)
- [x] City-classified video library page (ranked by views, All/Austin/SA filter)
- [x] Elegant premium visual design (graphite + champagne gold, Cormorant + Inter)
- [x] Owner-only auth gating on all routes

## Posting Integration
- [x] Scheduled endpoints: /api/scheduled/dueForPublish, /api/scheduled/reportPublish
- [x] Repost publish tracking columns (igMediaId, publishError)
- [x] Owner-only authorization (ownerProcedure) on all feature + scheduled endpoints
- [x] Owner-denial + unauthenticated tests added (18 tests passing)
- [x] Daily posting agent playbook written (posting_playbook.md)
- [x] Instagram connector UID identified for scheduled tasks
- [x] Deploy site (live at repostdash-qirdbvnd.manus.space) — scheduled endpoints reachable + 403-guarded
- [x] Scheduled posting task created (single job, cron 0 0 19,20 * * *, America/Chicago = runs 2PM & 3PM CDT). Per-city due-times in the dashboard make SA post on the 2PM run and Austin on the 3PM run, guaranteeing 1hr separation. Instagram connector attached.

## Testing
- [x] Vitest for selection engine (30-day cooldown, fallback, scheduling)
- [x] Vitest for caption refresh (hashtags/CTA preserved)
- [x] Vitest for confirm flow (repost creation + idempotency)
- [x] Vitest for auth logout
