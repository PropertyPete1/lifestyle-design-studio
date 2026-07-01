# Recovery + Anti-Duplicate + AI Analyst (Jul 1)

Scheduler calls repostdash-qirdbvnd (THIS project). Anti-duplicate fix ported here;
now replacing ffmpeg with a serverless-friendly differentiation and adding an AI analyst.

## Recovery (done)
- [x] Port server/sourceCooldown.ts
- [x] Port server/videoVariant.ts (ffmpeg best-effort; no-ops on Node-only prod)
- [x] Wire GUARD 1 (cooldown) + GUARD 2 (variant) into publishNowHandler
- [x] Add tests for checkSourceCooldown
- [x] tsc --noEmit clean + full test suite

## Diagnosis (evidence) - Phase 2
- [x] Pull yesterday's auto-post view counts per platform via Metricool API
- [x] Compare to recent manual re-posts of similar reels
- [x] Determine cause: skip-rate + audience size drive spread (NOT byte-identity); time drifted to evening. See DIAGNOSIS.md

## Anti-duplicate serverless (no paid infra) - Phase 3
- [x] Replace ffmpeg GUARD 2 with pure-Node byte-level differentiation (append random `free` MP4 boxes)
- [x] Verify runs on Autoscale Node-only runtime (no native binaries) — pure Buffer, tested
- [x] Strengthen per-post caption variation (more aggressive hook rewrite; NEVER alter hashtags; keep CTA verbatim)
- [x] Keep GUARD 1 cooldown (30-day no-repeat by postId + caption fingerprint)

## AI cross-platform performance analyst - Phase 4
- [ ] post_metrics DB table (postId, platform, views, likes, comments, reach, ts)
- [ ] Scheduled ingest of per-platform metrics for recent auto-posts (Metricool API)
- [ ] AI diagnoses underperformers + hypothesizes cause; compares auto vs manual
- [ ] Feedback loop: adjust differentiation strength / caption variation / timing
- [ ] Owner notification summary + dashboard "Performance" tab

## Ship - Phase 5
- [ ] Full tests + type-check + checkpoint
- [ ] Guide user to Publish; verify live on repostdash domain
