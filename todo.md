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

## Mobile Responsiveness
- [x] Mobile top bar + bottom tab bar nav (sidebar hidden on small screens)
- [x] Daily Picks cards: stack thumbnail/caption vertically on mobile
- [x] Library grid: 2-up on phone, touch-friendly tiles
- [x] History: readable on narrow screens (single-line date)
- [x] Bottom padding so content clears the mobile tab bar (Home, History, Library)
- [x] Verified all pages at 375px viewport

## Multi-Account Posting (Meta Graph API) — CANCELLED by user (Jun 26)
- [~] Cancelled: requires a one-time Meta/Facebook login to generate a Graph API token, which the user cannot currently do. No code changes were made to the live app for this. Can be revisited later if Meta access is restored.
- Note: No partial multi-account code was committed; dashboard remains single-account (@lifestyledesignrealtytexas).

## Auto-Pilot Toggle (auto-confirm)
- [ ] Add autoPilot boolean to app_settings (DB)
- [ ] Backend: getSettings/setAutoPilot procedures (owner-only)
- [ ] When auto-pilot ON, picks.today auto-confirms both picks (creates reposts, marks confirmed/queued)
- [ ] Auto-Pilot toggle UI on dashboard with clear on/off state + explanation
- [ ] Note: Instagram connector still shows a final confirm card at post time (Meta rule) — document workaround
- [ ] Test + deploy

## App Logo + PWA + GitHub (Jun 26)
- [x] Design a cool "Lifestyle Design Studio" app icon/logo (square, home-screen ready) — house emblem (Option 2) selected
- [x] Generate PWA icon sizes (192, 512, apple-touch 180, favicon 32)
- [x] Add manifest.webmanifest + apple-touch-icon + theme-color meta + app title "Lifestyle Design Studio"
- [ ] Verify "Add to Home Screen" works on phone (installable PWA)
- [x] Create private GitHub repo "lifestyle-design-studio" (PropertyPete1, private)
- [x] Push dashboard code to the repo (165 files on main)
- [ ] Deploy and hand over install instructions
