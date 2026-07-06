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
- [x] Verify "Add to Home Screen" works on phone (installable PWA) — manifest + icons + meta live & serving 200 on production
- [x] Create private GitHub repo "lifestyle-design-studio" (PropertyPete1, private)
- [x] Push dashboard code to the repo (165 files on main)
- [x] Deploy and hand over install instructions — published to repostdash-qirdbvnd.manus.space

## Bug: Blank screen on mobile (Jun 26)
- [ ] Investigate blank screen on mobile (likely service worker caching stale/empty shell, or SW interfering with auth)
- [ ] Fix and redeploy; verify on mobile

## Bug: Mobile shows "No picks available yet" (Jun 26) — UPDATED
- [x] Re-diagnosed: app shell renders fine on mobile; picks empty => owner not authenticated on phone (session not carrying) OR picks.today returns empty when unauthenticated
- [x] Confirmed: data is fine server-side (2 confirmed picks for today, valid videos + thumbnails); API correctly returns UNAUTHORIZED when not logged in
- [x] Root cause: service worker cached stale/empty app shell on mobile
- [x] Removed SW caching: self-destroying sw.js + auto-unregister/cache-purge on load
- [ ] Verify on mobile after redeploy

## Recurring Posting Agent (Jun 26)
- [x] Decided: Option B (confirm-each-time via IG card); AGENT cron fetches reel video and prepares post
- [x] Harden dueForPublish endpoint (now returns shortcode + permalink + caption); reportPublish already marks posted/failed
- [x] Verified flow: reportPublishHandler updates daily_picks + calls markRepostPosted/markRepostFailed (reposts row)
- [x] Saved checkpoint + user deployed (endpoints live, 403 for non-cron)
- [x] Scheduled AGENT cron: fires 19:00 + 20:00 UTC (2 PM SA / 3 PM Austin CDT), repeating, run-as-new, Instagram connector attached (taskUid he5uIWQiFJljmBdqvGrXLD)
- [x] Verified schedule active with correct cron/timezone; nothing fires today (next run tomorrow 2 PM CDT)
- [x] Deliver summary + how to manage/pause schedules

## Metricool Multi-Platform Integration (Jun 30)
- [x] Researched Metricool API - supports create scheduled post with autoPublish to all platforms
- [x] Stored METRICOOL_API_TOKEN secret, verified token works (blogId: 4807109, userId: 3748462)
- [x] Confirmed connected platforms: Instagram, TikTok, YouTube, Facebook
- [x] Added METRICOOL_BLOG_ID (4807109) and METRICOOL_USER_ID (3748462) to env/secrets
- [x] Built server/metricool.ts: createScheduledPost() + getConnectedNetworks()
- [x] Built /api/scheduled/publishNow: agent fetches video URL, server calls Metricool to auto-publish to Instagram + TikTok + Facebook
- [x] dueForPublish returns shortcode + permalink + caption for agent to fetch video
- [x] Updated schedule playbook: fully automatic (no confirm tap), Metricool handles all platforms
- [x] Wrote vitest test for metricool helper (live API validation, 19/19 pass)
- [x] Pushed to GitHub (PropertyPete1/lifestyle-design-studio, commit f1fb556)
- [x] Saved checkpoint f8eef5a5 — ready to deploy to production

## Bug Fixes: 30-Day Rotation + Duplicate Picks (Jun 30)
- [x] Confirmed 30-day filter IS working correctly (today's picks are genuinely different from June 26's)
- [x] Fixed duplicate Austin picks: added UNIQUE(pickDate, city) DB constraint + idempotent insertDailyPick
- [x] Cleaned up: deleted duplicate Austin pick (id 30003), kept id 30002
- [x] Today's picks are now clean: SA (id 30001) + Austin (id 30002), both pending, correct postIds
- [x] Saved checkpoint 6333707f — ready to deploy to production

## Fix: 30-Day Rotation vs Real Instagram Posts (Jun 30) — SUPERSEDED by AI Visual Dedup
- [x] Superseded: AI visual dedup is a better solution (handles reposts with different IDs)

## AI Visual Deduplication for 30-Day Rotation (Jun 30)
- [x] Built ig_post_history table (igPostId, thumbnailUrl, captionSnippet, postedAt)
- [x] Built server/igHistorySync.ts: syncIgPostHistory() + getRecentIgHistory() + isVisuallyDuplicate()
- [x] isVisuallyDuplicate() uses LLM vision to compare candidate thumbnail vs recent IG thumbnails (same property/development detection)
- [x] Integrated into ensureTodayPicks: tries up to 10 candidates, skips visually similar ones, fallback to top-ranked if all flagged
- [x] Added /api/scheduled/syncIgHistory endpoint for agent to sync posts before pick generation
- [x] Seeded ig_post_history with 20 recent Instagram posts (June 12-29, 2026)
- [x] Deleted today's bad SA pick (id 30001) — will regenerate with AI dedup on next dashboard open
- [x] Updated schedule playbook to sync IG history before generating picks
- [x] Pushed to GitHub (efa74c4)
- [ ] Save checkpoint + deploy to production

## Bug: SA Pick Still Wrong + Metricool All Accounts (Jun 30)
- [ ] Diagnose why SA pick still shows wrong video after AI dedup delete+regenerate
- [ ] Force clean SA pick regeneration with AI dedup running correctly
- [ ] Confirm all Metricool connected networks (Instagram, TikTok, YouTube) from live API
- [ ] Update publishNow to post to ALL connected Metricool accounts (not just Instagram)
- [ ] Deploy and verify

## Bug: SA Pick Keeps Repeating Same $279,990 House (Jun 30)
- [ ] Identify the $279,990 "All closing costs paid" video in the library (14.5K views, highest ranked SA video)
- [ ] Understand why it keeps winning selection despite being recently posted
- [ ] Fix: record confirmed picks in reposts table immediately on confirm (not just on post)
- [ ] Fix: ensure 30-day exclusion uses confirmedAt timestamp, not scheduledFor
- [ ] Delete today's bad SA pick and force regeneration with the fix in place
- [ ] Deploy and verify new SA pick is a genuinely different property

## ROOT CAUSE FOUND: Reposted video has different IG post ID (Jun 30)
- Library video id 22 (postId 18064623473412524, caption "bright light clean finishes") = same reel reposted June 28 as IG post 18100490300160803
- ID matching can't link them (different IDs); AI vision fails because ig_post_history thumbnails are EXPIRING Instagram CDN URLs (403 when AI fetches them)
- [ ] Fix: caption-fingerprint exclusion — exclude candidate videos whose caption matches a caption posted in last 30 days (ig_post_history)
- [ ] Normalize captions for comparison (lowercase, strip emoji/whitespace, first ~60 chars)
- [ ] Test, deploy, regenerate today's SA pick, verify different property

## FIX SHIPPED: Caption-fingerprint dedup (Jun 30)
- [x] Add captionFingerprint() (lowercase, strip emoji/punctuation -> words, first 80 chars) in igHistorySync.ts
- [x] Add isCaptionRecentlyPosted() — exact/prefix match + shared 4-word distinctive opening phrase
- [x] Wire isCaptionRecentlyPosted as PRIMARY dedup check in ensureTodayPicks() (before AI vision)
- [x] Fix fallback bug: when all candidates flagged, pick best CAPTION-CLEAN candidate instead of blindly using top-ranked video
- [x] Add captionDedup.test.ts (7 tests) covering the $279,990 reposted-house case
- [x] Verify type-check clean + all 26 tests pass
- [x] Runtime simulation with real DB captions: video 22 correctly flagged as duplicate (isDup=true)
- [x] Delete today's stale bad SA pick (id 90001, video 22) so it regenerates with fixed logic
- [x] Commit + push to GitHub (e0eb4e4), save checkpoint (e0eb4e46)
- [x] Verify SA pick regenerated as a genuinely different property (videoId 22 -> videoId 25, postId 17857030872602130; dev logs show video 22 skipped)
- [ ] User to click Publish to deploy fix to production

## Phone install (PWA) + LinkedIn target (Jun 30)
- [x] Add LinkedIn to Metricool posting targets (was IG/TikTok/YouTube only) + de-dupe networks
- [x] Map both linkedin (personal urn) and linkedinCompany fields to LINKEDIN
- [x] Add linkedinData block + dynamic platforms label in publishNow response
- [x] Add LinkedIn connectivity assertion to metricool.test.ts (verified live: IG, TikTok, YouTube, LinkedIn connected)
- [x] Verify prod manifest + icons + iOS meta tags serve correctly (all HTTP 200)
- [x] Add InstallAppButton: Android native prompt + iOS Add-to-Home-Screen instructions, hidden when already installed
- [x] Mount install button in mobile top bar
- [x] Type-check (clean) + tests (27 pass) + mobile layout verify
- [x] Adaptive iOS/Android instruction sheet; button shows on all phone-class devices
- [x] Extract pure installDetect helpers + 8 unit tests (verified: iPhone/iPadOS/Android show, desktop only with prompt, hidden when installed)
- [x] Include client tests in vitest config (35 tests total pass)
- [x] Checkpoint saved (89110b6e); hand off with install steps

## BUG: Mobile shows blank blocks (Jun 30)
- [x] Reproduce on mobile viewport (dev renders fine; issue is device-side stale cache)
- [x] Check logs: auth.me + picks.today both 200, no server errors — backend healthy
- [x] Verify prod assets/thumbnails load (JS 200, CSS 200, thumbs 307->200 image/jpeg)
- [x] Root cause: stale cached shell from old service worker on the device
- [x] Fix: early in-head SW-unregister + cache-purge guard (runs before app bundle)
- [x] Add boot fallback (spinner) so a failed load never shows blank screen
- [x] Remove boot fallback once React mounts
- [x] Add graceful <img> onError fallback ("Preview unavailable")
- [x] Verify Daily/Rotation/Library on 390x844 mobile viewport (all render)
- [x] Type-check clean + 35 tests pass
- [x] Checkpoint saved (d98aa068); hand off retest steps (force-refresh on phone)

## BUG: Metricool posts stay PENDING — "Video not available" / 4 errors (Jun 30)
- [x] Root cause part 1: post body shape (lowercase providers, media as {url,type} objects, drop saveExternalMediaFiles) — fixed, returns HTTP 200
- [x] Root cause part 2: IG CDN media URL expires/blocked → Metricool can't fetch video → "Add at least 1 image or video" on all networks
- [x] Real fix: upload the video into Metricool's OWN media library via their S3 upload flow (PUT /v2/media/s3/upload-transactions -> presigned S3 PUT -> PATCH complete), then post with the static.metricool.com hosted URL. External URLs always expire before Metricool ingests them.
- [x] Cracked the S3 403 SignatureDoesNotMatch: the transaction part `hash` MUST be base64(sha256) of the bytes, and the S3 PUT must send `x-amz-checksum-sha256` = that same base64(sha256). Metricool signs the presigned URL with that exact value.
- [x] Implemented uploadVideoToMetricool() in server/metricool.ts; createScheduledPost now uploads media by default (uploadMedia flag)
- [x] SECOND root cause: `media` must be an array of bare URL STRINGS. Sending [{url,type}] objects made Metricool silently persist EMPTY media (post then errors "add a picture/video"). Fixed createScheduledPost to send media: [url].
- [x] Fixed immediate-publish scheduling: added chicagoLocalDateTime() so publicationDate.dateTime is a true America/Chicago wall-clock string (was UTC ISO slice, ~5h late). Used in publishNowHandler + republish.
- [x] Re-published today's Austin reel via corrected path — VERIFIED PUBLISHED on Instagram, TikTok, YouTube, AND LinkedIn (Metricool post 343860379); repost 30003 igMediaId updated
- [x] Scheduled cron publishNow flow calls createScheduledPost -> now auto-uploads media + uses Chicago-local time (no further change needed)
- [x] Added tests: uploadVideoToMetricool returns hosted CDN url; chicagoLocalDateTime timezone semantics (39 tests pass)
- [x] Checkpoint saved + deployed to production; all 4 scheduled endpoints live and auth-gated; cron verified for tomorrow (SA 2PM / Austin 3PM CDT)

## Multi-brand posting (max exposure across all connected IG accounts)
- [x] Discover ALL Metricool brands at post time via getAllBrands(simpleProfiles), not a hardcoded blogId
- [x] uploadVideoToMetricool now takes blogId + reusable prefetched bytes; authParams parametrized by blogId
- [x] createScheduledPost fans out to every brand (postToBrand) with that brand's networks (IG always; +TikTok/YouTube/LinkedIn on main)
- [x] Aggregated per-brand results into ok/platforms summary; partial failures surfaced in summary
- [x] publishNow already returns result.platforms summary and marks posted when >=1 brand succeeds (no change needed)
- [x] Live-tested fan-out to all 3 brands (3 posts created + cleaned up); added getAllBrands test; tsc clean
- [x] Auto add/remove: brands discovered live each run, so a newly connected IG is auto-included and a removed one drops out with no code change
- [x] Deployed to production (bundled with the Dallas release below)

## AI geo-classification + Dallas market (every 2 days)
- [x] Added `dallas` to city enums (videos, reposts, daily_picks); migration applied
- [x] geoClassify.ts: deterministic keyword pass + AI vision fallback -> san_antonio | austin | dallas
  - SA: San Antonio metro + Schertz, Cibolo, Alamo Ranch, New Braunfels, Boerne, Seguin, Canyon Lake
  - AUSTIN: Austin metro and NORTH (Round Rock, Georgetown, San Marcos, Temple, Killeen, Belton, Waco)
  - DALLAS: Dallas, Fort Worth, Arlington, Plano, Frisco, McKinney, Denton, etc.
- [x] Re-classified existing library (107 videos): 89 SA / 18 Austin / 0 Dallas (no DFW reels in current synced source)
- [x] selection.ts: scheduleHourFor (SA 2PM/Austin 3PM/Dallas 4PM) + isDallasDay every-other-day cadence
- [x] ensureTodayPicks generates Dallas pick only on Dallas days; silently skips if no Dallas videos
- [x] Dallas fans out to ALL brands via existing multi-brand path; 30-day no-repeat applies
- [x] UI: Dallas-Fort Worth label, dashboard copy, Library filter tab, dynamic pick list
- [x] Scheduled task updated: cron 0 0 19,20,21 UTC (2/3/4 PM CDT), agent loops SA->Austin->Dallas
- [x] Tests: geoClassify, dallasSchedule (hour + cadence); 48 tests pass; tsc clean
- [ ] Checkpoint + deploy + verify in production
- [ ] NOTE FOR PETER: no Dallas/Fort Worth videos found in the synced IG source — need the account/videos that contain DFW reels for Dallas days to actually post

## Fort Worth deep backfill (one-time) (Jul 1)
- [x] Paginated full Instagram history via connector (~12 pages, ~230 posts)
- [x] Identified 6 genuine Fort Worth / DFW-area reels (Aledo ISD, Benbrook/Crowley ISD, Joshua ISD / DFW side)
- [x] Fetched real IG insights (views) per reel; hosted thumbnails on storage; upserted as city=dallas
- [x] Strengthened geoClassify with DFW suburb/ISD keywords (Aledo, Benbrook, Crowley ISD, Joshua ISD, Chisholm Trail, Mansfield, Burleson, etc.)
- [x] Library now: 89 San Antonio / 18 Austin / 6 Dallas
- [x] Verified a Dallas pick can generate (top eligible = post 18395283235198565, 1095 views, 0 reposts in 30d)
- [x] Checkpoint saved (1b6d0a48) + user deploys


## Low-Views Fix + AI Performance Analyst (Jul 1)
- [x] Diagnosis: pulled live per-brand IG reel analytics; skip-rate + audience size (not byte-identity) drive the spread; posting time drifted to evening
- [x] Replace ffmpeg GUARD 2 with serverless byte differentiation (append random `free` MP4 boxes; pure Node, runs on Autoscale)
- [x] videoVariant.test.ts: source preserved, hash changes, distinct per call, valid `free` boxes
- [x] Strengthen caption variation (rewrite hook/body more aggressively; hashtags + CTA verbatim; prefer Comment over DM)
- [x] AI analyst: post_metrics + analyst_insights tables created (migration applied)
- [x] Scheduled metrics ingest via Metricool analytics endpoints (IG reels; server/metricoolAnalytics.ts) — verified live (30 posts, 3 brands)
- [x] AI diagnosis: flag underperformers vs each brand's OWN trailing median; skip-rate correlation surfaced (flagged 74% vs top 63%)
- [x] performanceAnalyst.ts: median engine + LLM strategy + persistence + owner notification; 5 unit tests pass
- [x] /api/scheduled/runAnalyst endpoint (auth-gated, Heartbeat-ready) + trpc analyst router (latest/list/metrics/run)
- [x] Performance tab UI: report, per-brand medians, skip-rate lever, recent-posts table (zero-view rows filtered)
- [x] Verified live analyst run: real report generated, owner notified
- [x] Verify/lock posting time to 2/3/4 PM CDT (scheduleHourFor: SA 14 / Austin 15 / Dallas 16 CDT; automatic cron path uses these; evening drift was manual re-publishes only)
- [x] Full tests + type-check pass (64 tests, 13 files, 0 TS errors)
- [ ] Save checkpoint + user publishes + register nightly analyst schedule after publish


## Status note (Jul 1) — stale unchecked items reconciled
The remaining `- [ ]` boxes above are historical, NOT open work for the Jul 1 "maximum results" build:
- Auto-Pilot Toggle: never requested for this build; left as a future option.
- Meta Graph API multi-account: CANCELLED by user (superseded by Metricool multi-brand, which is live).
- "SA pick wrong / $279,990 repeating" bugs: SUPERSEDED and fixed by caption-fingerprint dedup + AI visual dedup (both shipped, verified).
- "Verify on mobile after redeploy" / blank-screen: fix shipped (self-destroying SW + boot fallback); needs only a user device retest.
- "User to click Publish" lines: deployment is a user action (Publish button); code is ready.
Current build (low-views fix + AI performance analyst) is complete and green: 64 tests pass, 0 TS errors, live analyst run verified.


## AI Hook Optimizer (active view-optimizer) — Jul 1
- [x] hookOptimizer.ts: rewrite ONLY opening hook, learn winning hooks from post_metrics (views discounted by skip)
- [x] Preserve long caption body, hashtags verbatim, and "Comment [word]" CTA verbatim; fail-safe guards
- [x] Wired into daily pick generation + manual regenerate (after refreshCaption)
- [x] likelyWeakFirstFrame heuristic hint
- [x] analyst.topHooks tRPC query + Performance tab "AI Hook Optimizer" section (winning hooks)
- [x] 16 unit tests for optimizer safety (CTA preserved, no hashtag change, no gutting, fail-safe); full suite 86/86 pass, 0 TS errors
- [x] Checkpoint (ec165d65) + push to GitHub (PropertyPete1/lifestyle-design-studio, commit ec165d6)


## Nightly Analyst Schedule — Jul 1
- [x] Registered project-level Heartbeat cron "nightly-analyst-7amct" (task_uid LPifEYtstgsDBzCEtPgHyH), cron "0 0 12 * * *" = 7 AM CT, path /api/scheduled/runAnalyst
- [x] Verified: job listed, next run 2026-07-02T12:00:00Z; production endpoint reachable and 403-guarded without cron auth

## Fully Automatic Posting (no manual tap)
- [x] Auto-confirm picks at generation time (create repost row + status=confirmed) so the 2/3/4 PM agent finds them due
- [x] Add /api/scheduled/generatePicks morning Heartbeat endpoint so tomorrow's picks always exist before the posting window
- [x] Register a morning Heartbeat cron 8 AM CT (0 0 13 * * * UTC) -> /api/scheduled/generatePicks (task_uid nznYBLuykxrdysEkSxyVBj, next 2026-07-02T13:00Z = 8 AM CDT)
- [x] Keep manual Confirm working as a graceful no-op (already-confirmed handled)
- [x] tsc + vitest pass (87/87); checkpoint saved (59c4a4f7); pushed to GitHub (github/main ec165d6..59c4a4f)
- [x] Self-heal in dueForPublish: ensureTodayPicks (generate + auto-confirm) runs before the due check, so posting works even if morning cron/app never ran

## Mobile App Access (recurring blocker - 5th report)
- [x] Diagnosed: server verified ONLY the cookie; a stale/expired mobile cookie caused rejection and the valid Bearer fallback was never tried
- [x] Reviewed auth path (sdk.authenticateRequest, useAuth, sessionToken, oauth callback fragment handoff)
- [x] Fixed: authenticateRequest now falls back to the valid Bearer token when the cookie is invalid/stale (no security removed); added 3 unit tests; 90/90 pass
- [x] Tests pass (90/90), checkpoint 633b4015, pushed to GitHub (92f3999..633b401)
- [x] User published. Live verified on production: stale cookie alone -> 401; stale cookie + valid Bearer -> auth succeeds (reaches owner check), proving the Bearer fallback now works on the deployed build. Owner-only gate intact.

## New IG Brand + LinkedIn Recruiting Posts
- [x] Confirmed 4 IG brands on Metricool; new brand (lifestyledesignrealty) auto-picked-up for reels
- [x] Confirmed only lifestyledesignrealtytexas has LinkedIn connected (personal profile)
- [x] Stop reels from posting to LinkedIn (removed LINKEDIN from video fan-out; IG/TikTok/YouTube only)
- [x] DB: linkedin_posts table + helpers (getLinkedinPostByDate, insertLinkedinPost, updateLinkedinPost, getRecentLinkedinPosts, getDueLinkedinPost)
- [x] AI author (linkedinAuthor.ts): Peter Allen voice, recruiting angle, hook/value/CTA, <150 words, no dashes, no quotes, 6-topic rotation, sanitizer
- [x] Self-improvement: buildLearningContext feeds recent posts + engagement (best performer) back into the prompt
- [x] Metricool: publishLinkedinText (text-only, providers=[linkedin], no media) to blogId 4807109
- [x] Endpoints: /api/scheduled/generateLinkedin (morning) + /api/scheduled/publishLinkedin (2 PM CT, self-heal), registered in _core/index.ts
- [x] Dashboard UI: LinkedinPage (view/edit/regenerate today, word count, status, history) + nav tab + route; renders live
- [x] Tests: added linkedinAuthor.test.ts (sanitizer, rotation, generation guardrails); full suite 100/100 pass, 0 type errors
- [x] Checkpoint 5fd67a6e; pushed to GitHub (633b401..5fd67a6)
- [x] Deployed live; endpoints verified (403 cron-guard). Registered crons: linkedin-daily-2pm 0 0 19 UTC=2PM CDT (8gNRh2sUxNaLJ4UqFqz5aW), linkedin-morning-generate 0 0 13 UTC=8AM CDT (keCGL7YnnscBgujeL7GmdH). Both enabled, next-run 2026-07-02.

## Multi-brand LinkedIn posting (2 new LinkedIn brands)
- [x] Add getLinkedinBrands() (LinkedIn profile OR company, no INSTAGRAM requirement)
- [x] Verified 3 LinkedIn brands: lifestyledesignrealtytexas(4807109), lifestyledesignrealtyaustintx(6486275, new), lifestyledesignrealty(6493212, new)
- [x] Publish to ALL LinkedIn brands via getLinkedinBrands(), staggered 30 min apart (2:00/2:30/3:00 PM CT)
- [x] Track per-brand results in linkedin_posts.brandResults JSON (blogId,label,ok,postId,publishAt,error); partial-failure aware status
- [x] Update dashboard copy to reflect multi-brand posting + per-brand result chips in history
- [x] Tests: added getLinkedinBrands live test (101/101 pass, 0 type errors)
- [x] Checkpoint ff9c20b6; pushed to GitHub (5fd67a6..ff9c20b)
- [x] Deployed live; both LinkedIn endpoints verified (403 cron-guard) on production. getLinkedinBrands live-verified returns all 3 LinkedIn pages.

## LinkedIn Self-Optimization (real engagement -> angle weighting)
- [x] Probed live: GET /v2/analytics/posts/linkedin works per blogId. Returns data[] with postId(urn), created.dateTime, impressions, uniqueImpressions, engagement, comment(text). Reactions/comments/shares fields appear once posts accrue engagement. New brands return empty until they have posts.
- [x] Reuse existing fetchLinkedinPosts in metricoolAnalytics.ts (already normalizes impressions/reactions/comments/shares); add a LinkedIn-brand ingest that also reads `engagement` + urn postId
- [x] linkedinAnalytics.ts + /api/scheduled/syncLinkedinAnalytics: pulls per-brand LinkedIn analytics, matches by URN, writes engagement to linkedin_posts
- [x] Aggregates impressions/reactions/comments/shares across all brand URNs onto the day's post row (idempotent, only writes on change)
- [x] pickTopicForDate: engagement-weighted (comments x3, shares x5), normalized, floor keeps every angle in rotation; deterministic per date
- [x] Guard: WEIGHTING_MIN_POSTS=6 posts-with-engagement before weighting; before that, plain even 6-way rotation. Writer now uses pickTopicForDate.
- [x] Tests: linkedinWeighting.test.ts (7) covers scoring, thin-data guard, determinism, favors-winner, floor-keeps-all. Full suite 108/108 pass, 0 type errors
- [x] Checkpoint a892507b; pushed to GitHub (ff9c20b..a892507)
- [x] Deployed; endpoint verified (403 cron-guard). Registered linkedin-analytics-sync 0 30 18 UTC = 1:30 PM CDT (task_uid bCnWxXePkAaL8RdiBeCDi8), enabled. Runs before the 2 PM publish so each new post learns from the latest engagement.

## Drive-Original Matching (replace IG copy with Drive original for high views)
- [x] Found Drive folder (id: 16mNnK1avek0LUljjFPZ5iNxON2OJZod7): 43 videos (mp4+mov), 23-135MB, most have Google thumbnails, still growing
- [x] DB: drive_videos table (driveFileId PK, fileName, mimeType, sizeBytes, durationMs, width, height, thumbnailUrl, hostedThumbnailUrl, driveCreatedAt, lastIndexedAt)
- [x] DB: daily_picks.driveVideoUrl (text) + daily_picks.driveMatchConfidence (varchar 16) columns added
- [x] driveIndex.ts: sync Drive folder metadata to drive_videos table via gws CLI (paginated, idempotent upsert)
- [x] driveMatcher.ts: AI vision matching (gemini-3-flash-preview) — duration filter then batch thumbnail comparison, structured JSON output, high/medium confidence only
- [x] drivePreprocess.ts: full morning pipeline (sync index → match → download via gws → variant fingerprint → upload to S3 → store URL on pick)
- [x] Integrated into generatePicksHandler: after picks generated + auto-confirmed, Drive preprocessing runs (non-blocking on failure)
- [x] publishNow updated: prefers pick.driveVideoUrl (already differentiated) over body videoUrl; skips re-variant when using Drive original
- [x] publishNow graceful failure: if no Drive original AND no body videoUrl, marks pick failed with clear reason
- [x] drivePreprocess.test.ts: 8 tests (module exports, early-return, match logic, Drive-source preference, variant skip)
- [x] All 116 tests pass, 0 type errors
- [ ] Checkpoint + push to GitHub + deploy + verify live

## REBUILD: Drive-Only Video Source (Jul 4) — user directive
- [ ] Clear today's picks entirely (nothing posts today)
- [ ] Wipe old IG video library (videos table) — source of repeated/stale content
- [ ] Wipe old reposts history (causes old data to keep surfacing)
- [ ] Wipe ig_post_history (no longer needed — not using IG as source)
- [ ] Rebuild selection: pick from drive_videos table ONLY (not old videos table)
- [ ] Drive videos are the single source of truth: index Drive folder, classify by city, rank by IG views (from caption/metadata), enforce 30-day no-repeat
- [ ] Morning job: sync Drive index → select best Drive video per city → post original from Drive
- [ ] No more IG-downloaded videos anywhere in the pipeline
- [ ] Test, checkpoint, deploy

## FULL REBUILD: Drive-Only with AI Vision Matching (Jul 4) — NO IDs
- [x] Remove ALL ID-based matching from the codebase (postId matching, filename ID extraction, etc.)
- [x] Build IG scraper: fetch reels with views, engagement, description, thumbnail (for ranking only)
- [x] Store scraped IG data in a new table (ig_reels) with: thumbnail, caption, views, likes, city, engagement score
- [x] Selection engine: pick best engagement reel not posted in 30 days (30-day check uses AI vision on thumbnails, NOT IDs)
- [x] AI vision matcher: given the picked IG reel thumbnail, find the matching Drive original by visual similarity ONLY
- [x] Wire morning pipeline: scrape IG → rank → pick best → AI vision match to Drive → download Drive original → variant → upload to S3
- [x] publishNow uses the pre-uploaded Drive original (storage key → fresh signed URL)
- [x] 30-day dedup is VISUAL ONLY: AI compares thumbnails of candidate vs last 30 days of posts
- [x] Remove old postId/videoId references from selection, dedup, and cooldown logic
- [x] driveIndex.ts rewritten: Google Drive REST API via fetch() (no gws CLI)
- [x] drivePreprocess.ts rewritten: fetch() download + ig_reels for metadata + storageGetSignedUrl for thumbnails
- [x] driveMatcher.ts fixed: max_tokens 256→2048
- [x] db.ts: new helpers (getReelsByCity, getAllReels, getReelById, getReelByIgMediaId, getLastPostByIgMediaId, getRecentPostHistory)
- [x] selection.ts: new selectReelForCity() for ig_reels pipeline (engagement-ranked, 30-day cooldown)
- [x] ensureTodayPicks rewritten: reads from ig_reels, dedup via caption-fingerprint + AI vision against post_history
- [x] scheduledPublish.ts: dueForPublish + publishNow use ig_reels; scrapeReelsHandler added
- [x] /api/scheduled/scrapeReels endpoint wired in _core/index.ts
- [x] All 116 tests pass, 0 TypeScript errors
- [x] Checkpoint + deploy
- [x] Fix Metricool publish: thumbnail must be full signed URL (not relative /manus-storage/ path)
- [x] Fix caption safety guard: reject LLM meta-responses ("didn't come through", "paste the full", etc.)
- [x] San Antonio re-published successfully with correct video + caption (Metricool post 345524379)

## Auto-Pilot Toggle (Jul 4)
- [x] Backend: settings.getAutoPilot + settings.setAutoPilot tRPC procedures (owner-only)
- [x] Wire autoPilot check into dueForPublishHandler (returns due:false when OFF)
- [x] Wire autoPilot check into generatePicksHandler (skips Drive preprocessing when OFF)
- [x] UI: Auto-Pilot toggle button in dashboard header (green ON / amber OFF, with Switch)
- [x] Optimistic mutation with toast feedback
- [x] Set autoPilot = true in DB (system is ON and fully autonomous)
- [x] All 116 tests pass, 0 TypeScript errors

## Prefer 4K Drive Originals (Jul 4)
- [x] Refresh Drive index with video resolution metadata (width, height from Google Drive API)
- [x] Update driveMatcher to return ALL visual matches (not just first), ranked by resolution
- [x] drivePreprocess picks the highest-res version when multiple files match the same property
- [x] Test + checkpoint (all 116 tests pass)

## Bug Fix: Caption Truncation — Missing CTA + Hashtags (Jul 4)
- [x] Root cause: update_thumbnails.mjs had `.slice(0, 500)` truncating captions before DB insert
- [x] Removed `.slice(0, 500)` from update_thumbnails.mjs
- [x] Re-scraped all 180 reels from Instagram API with full captions (avg 1,326 chars, max 2,199 chars)
- [x] Updated ig_reels table: 0 captions at exactly 500 chars, 179 over 500, 155 over 1,000
- [x] Fixed captionRefresh.ts splitHashtags(): now properly extracts CTA lines (Comment/DM/FILL OUT/⬆️/⭐️ patterns) as separate `cta` field
- [x] Fixed hookOptimizer.ts: uses new `cta` field from splitHashtags + re-attaches CTA block to final caption
- [x] Regenerated today's 3 picks (SA, Austin, Dallas) with full captions including CTA + hashtags
- [x] Verified: all 3 picks now have captions 1,500+ chars with hashtags (#veteran #military #texas #realestate) and CTA preserved
- [x] All 120 tests passing (including 8 new captionRefresh tests + 16 hookOptimizer tests)

## Bug Fix: SA Pick Violating 30-Day Rule — Original Post Date (Jul 4)
- [x] Root cause: selection logic only checked repost history, not the reel's original IG post date
- [x] Video 18 (postId 18107071295064920) was originally posted on IG June 19 (15 days ago) — audience already saw it
- [x] Fix: selectReelForCity now also excludes reels whose `postedAt` (original IG post date) is within 30 days
- [x] 99 of 129 SA reels are older than 30 days — plenty of eligible content
- [x] Deleted bad SA pick + repost, regenerated: new SA pick is video 25 (posted May 1, 64 days ago, 2,880 views)
- [x] All 120 tests passing

## Enforce 4K-Only Posting (Jul 4)
- [x] publishNow: reject any post that doesn't have a Drive original (no IG CDN fallback)
- [x] drivePreprocess: if Drive match/download fails for a pick, try next eligible reel for that city
- [x] Keep trying next eligible reels until one gets a successful Drive download (never skip a day)

## Fix: Auto-Compress Oversized Videos for Metricool (Jul 5)
- [x] Root cause: Metricool has 100MB per-part upload limit; Austin Drive original was 127.7MB (2160x3840 at 55 Mbps)
- [x] Added compressVideoToFit() in metricool.ts: ffmpeg CRF 26→32 ladder, keeps full 4K resolution, targets <95MB
- [x] Integrated into createScheduledPost: auto-compresses any video >95MB before uploading to Metricool
- [x] Manually posted today's SA (41.8MB, success) and Austin (compressed 127MB→73MB, success) via Metricool
- [x] Fixed repost sync bug: when drivePreprocess swaps a pick to alternate reel, also updates the reposts row postId
- [x] All 120 tests passing, 0 TypeScript errors

## Drive Health Check + Auto-Notification (Jul 5)
- [x] Build driveHealthCheck() function: lightweight Drive API call (list 1 file) to verify token is valid
- [x] Integrate into generatePicksHandler: run health check first, if fails → notify owner immediately + skip Drive preprocessing
- [x] Integrate into publishNowHandler: if pick has no driveVideoUrl, attempt Drive preprocess one more time before failing
- [x] Owner notification on disconnect: push notification "Google Drive disconnected — re-enable in Manus settings"
- [x] Also notify on publish failure (post couldn't go out due to no Drive original)
- [x] Tests pass (120/120), 0 TypeScript errors

## AI Voiceover Pipeline (Jul 6)

### Phase 1: Infrastructure
- [x] Add ELEVENLABS_API_KEY env var via webdev_request_secrets
- [x] Create voiceover DB tables (voiceover_jobs, voiceover_budget)
- [x] Build ElevenLabs service module (voice lookup, TTS, character tracking)

### Phase 2: Audio Intelligence + Script Generation
- [x] Detect speech vs music-only in source videos (ffprobe audio analysis)
- [x] Surface audio type status per video in dashboard
- [x] LLM-powered script generation (paced to video duration, brand rules, emotional tags)
- [x] Script approval UI in dashboard (editable, approvable before TTS)

### Phase 3: TTS + Duration Matching + Video Assembly
- [x] ElevenLabs TTS generation with Peter's Pro Voice + v3 model
- [x] Duration comparison: audio vs video (±5% tolerance)
- [x] FFmpeg atempo stretch/compress within 0.95x–1.05x
- [x] Flag mismatch in dashboard if beyond tolerance
- [x] Video assembly: voiceover layer + duck original audio (15-20%) or mute
- [x] Loudness normalization to -14 LUFS
- [x] Word-by-word caption burn-in (forced alignment + ffmpeg subtitle overlay)
- [x] Caption style: bold, centered lower-middle third, white text black outline, safe-zone aware

### Phase 4: Dashboard UI
- [x] Voiceover toggle per post ("Add Peter voiceover" on/off, default OFF)
- [x] Script editor with approval button
- [x] Video preview player (final rendered video before posting)
- [x] "Regenerate audio" button (reuses approved script)
- [x] Monthly character budget meter (warn at 80%, pause at 100%)
- [x] Audio type indicator (speech detected vs music-only)
- [x] Duration mismatch flag display

### Phase 5: Pipeline Integration
- [x] Connect voiceover to existing pick → approve → post flow
- [x] Final rendered video = transformed version for Metricool posting
- [x] Log ElevenLabs character usage per video
- [x] Cache generated audio (reuse if script unchanged)
- [x] Save rendered videos to S3 storage (Drive upload deferred to post-publish)
- [x] Error handling: if ElevenLabs fails, flag for retry, don't post
- [x] Validate final video meets IG Reels specs (9:16, codec, length)
- [x] Nothing posts automatically — human approval required

## Auto Voiceover Mode (Jul 6)
- [x] Add autoVoiceover setting to settings table (default ON)
- [x] Add tRPC procedures: getAutoVoiceover / setAutoVoiceover
- [x] Auto-start voiceover jobs in generatePicksHandler when autoVoiceover is ON
- [x] Make pipeline fully automatic: script → TTS → render → auto-approve (no manual step)
- [x] Add "Auto Voiceover" toggle to dashboard UI (next to Auto-Pilot toggle)
- [x] Show voiceover status on pick cards even when auto mode is on
## Reposts UI: Compression Metadata Display (Jul 6)
- [x] Added compressedFileSizeMb and crfValue columns to reposts table
- [x] Migration applied (0012_chubby_ghost_rider.sql)
- [x] updateRepostCompression() DB helper added
- [x] createScheduledPost returns compression metadata (fileSizeMb, crfValue) when video was compressed
- [x] publishNowHandler saves compression metadata to repost row after successful publish
- [x] HistoryPage UI shows amber badge with file size + CRF value for compressed videos
- [x] All 121 tests passing, 0 TypeScript errors
