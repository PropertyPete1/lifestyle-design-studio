# LDT Brand Lane — Setup & Auth Reality

Brand 2: **Lifestyle Design Technologies** — IG `@lifestyledesigntechnologies`,
TikTok `@lifestyledesigntech`. Marketing PRIMARY, from the system PRIMARY's
company builds.

## What auth exists today (and what doesn't)

All posting goes through **one Metricool account**, authenticated by three
repo secrets that already exist and cover the whole account:

| Secret | Scope |
| --- | --- |
| `METRICOOL_API_TOKEN` | account-wide API token (`X-Mc-Auth` header) |
| `METRICOOL_USER_ID` | account id — every brand on the account shares it |
| `METRICOOL_BLOG_ID` | pins the MAIN realty brand only (manual-assist IG skip) |

**There is no LDT-specific API token and none is needed.** A Metricool "brand"
is a profile inside the same account; once the LDT accounts are connected as a
new brand, the existing token can post to it. The lane finds the LDT brand **by
handle** (from `brands.json`) and fails closed — until the connect below is
done, every scheduled run exits green with a `[DAILY ALERT]` notice instead of
posting.

Google Drive access reuses the existing `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` — same account that owns the
city folders. Captioning uses the existing `ANTHROPIC_API_KEY`.

## One-time connect steps (Peter, ~15 minutes)

1. **Metricool → add the brand.** app.metricool.com → brand switcher → *add
   brand* → name it `Lifestyle Design Technologies` (any name containing
   "LDT" or "Lifestyle Design Tech" also matches, but the handles below are
   the authoritative signal).
2. **Connect Instagram** `@lifestyledesigntechnologies` inside that brand.
   Requirements for auto-publish: the IG account must be **Professional**
   (Business or Creator) and **linked to a Facebook Page**; Metricool walks
   through the Facebook login to grant it.
3. **Connect TikTok** `@lifestyledesigntech` inside the same brand (TikTok
   OAuth login; approve the posting permission).
4. **Create the intake Drive folder** (e.g. `LDT Intake`) in the same Google
   account the poster already uses (the one `GOOGLE_REFRESH_TOKEN` was minted
   for — the account that owns the city video folders). Copy the folder ID
   from the URL.
5. **Set one new repo secret:** `LDT_INTAKE_FOLDER_ID` = that folder ID.
   (Settings → Secrets and variables → Actions.)
6. Optional smoke test: Actions → *LDT Brand Post* → Run workflow with
   `dry_run: true`. The log should print `Target brand resolved` with the new
   blogId, and a generated caption.

Nothing else. No new tokens, no code changes, no redeploys.

## What the lane does

- **Intake clips first**: oldest unposted video in the intake folder →
  QC (landscape allowed — screen recordings) → caption in the LDT voice →
  claims gate → posts to IG (Reel) + TikTok on the LDT brand only.
  Each clip posts exactly once.
- **Self-made fallback**: when no clip lands, a generated piece — the
  8-slide narrative carousel leads, the single promo card and the silent
  text-motion reel alternate behind it ($99/mo positioning, angle rotating
  daily, one post per format per day, every line of copy backed by
  `ldt-claims.json`). See `LDT-SELFMADE.md`.
- **Cadence**: 3/day per platform (config: `brands.json`), fired by three
  spread slots — 10:00 AM, 2:00 PM and 6:00 PM CT. Hard cap 6/day — a config
  above the cap is **refused at startup**; 3–6 runs only with the explicit
  config change and logs a warning every run (3/day does, by design). A
  3-hour minimum gap applies between any two LDT posts, which is why the
  slots sit on a four-hour pitch: an hour of slack, so a late-firing slot
  isn't silently skipped. Raising the cadence again means adding a slot and
  keeping that gap — CI pins the cron count to the cadence.
- **Learning loop**: the LDT brand gets its own brief
  (`performance-weights.ldt.json`) fed from its own blogId's reel analytics —
  fully separate from the realty weights. (The read-only daily collector,
  `status/social_analytics.json`, will also start including the LDT accounts
  once connected — that file is keyed per account, so this is by design, not
  a leak.)

## Honest-claims doctrine

`ldt-claims.json` mirrors the sales site's test-pinned copy and is the ONLY
permitted source of factual claims in generated captions and promo slides.
The gate is mechanical (`src/ldt-claims-gate.js`): banned overclaims
("never lies", "guarantee", retired tier names, live scarcity counts) fail
the caption, and every stated figure must match a pinned figure exactly —
$99 passes, $98 does not. When the site's copy changes, update
`ldt-claims.json` in the same PR.

## Brand isolation (why realty can't leak here)

Both realty fan-outs (`getAllBrands`, `getCarouselBrands`) now skip any
Metricool profile claimed by another brand in `brands.json` — matched by IG/
TikTok handle, with brand-label patterns as backup. Until the LDT accounts
are connected, the filter matches nothing and realty discovery is unchanged.
The LDT lane, inversely, posts **only** to its claimed profile and never
falls back to "all brands".
