# Phase 0 — Tenant Audit

**Status: design doc, no code written. For Peter's review.**
Scope: the daily side only (reels, trial variants, carousel, LinkedIn). The YT long-form freeze is respected — `yt-*.js` is inventoried where it shares a mechanism, never changed.

---

## 0. The gate, first

You said this workstream starts after the daily-systems audit reaches zero. **It has not reached zero.** As of this writing:

- `audit/daily-systems` is checked out and sits at the same commit as `main` (`2567d14`) — nothing has landed.
- There is **uncommitted in-flight work** on it: `post.yml`, `carousel-main.js`, `delivery.js`, `main.js`, `trial-variant-main.js` modified (+285/−27), plus two untracked new modules, `daily-notify.js` and `failure-remedy.js`.
- The suite is **1111/1112 green**. The one failure is that in-flight work: `tests/mail-subject.test.mjs:65` still asserts `MAIL_PREFIX` has exactly three entries, and `delivery.js` now adds a fourth (`[DAILY ALERT]`).
- Files changed underneath me between two checks minutes apart, so that work is live right now.

So: this doc is the correct thing to deliver today, and it is safe — reading the system to inventory it cannot clone a bug. **Building Phase 1 should wait** until that branch lands and the suite is back to green, for exactly the reason you gave.

---

## 1. What "the daily side" actually is

It is not one system. It is four pipelines sharing an engine, and they tenant-ize very differently. This distinction drives everything below.

| Pipeline | Entry | Source material | Ports to cleaning? |
|---|---|---|---|
| **Reels** (per city, 5 slots/day) | `src/main.js` | Drive footage w/ price overlays | **Front half does not** — see §5.3 |
| **Trial variants** (2/day) | `src/trial-variant-main.js` | Re-cuts of reel sources | Follows reels |
| **Daily carousel** (1/day) | `src/carousel-main.js` | Pure text generation, no footage | **Cleanly** — best proof target |
| **LinkedIn recruiting** (1/day, 3 personas) | `src/linkedin.js` | Pure text generation | **Does not port at all** — see §5.2 |

The carousel is the one to prove Phase 3 on. It has no footage dependency, no vision step, no KB, and its writer/critic loop is genuinely generic. The reels pipeline is where the real-estate assumptions are load-bearing.

---

## 2. Inventory — per-tenant config

Every item here is a value that must move into tenant config. `file:line` is where it lives today.

### 2.1 Identity, contact, CTA mechanics

| What | Where | Note |
|---|---|---|
| Owner email | [`delivery.js:21`](auto-poster/src/delivery.js:21) | `OWNER_EMAIL` const |
| IG handle in delivery mail | [`delivery.js:438`](auto-poster/src/delivery.js:438), [`:503`](auto-poster/src/delivery.js:503) | `@lifestyledesignrealtytexas` |
| Brand name as a **required** caption marker | [`caption-validator.js:23`](auto-poster/src/caption-validator.js:23) | Engine **rejects** any caption lacking "Lifestyle Design Realty" |
| Brand line in prompt + fallbacks | [`caption.js:554`](auto-poster/src/caption.js:554), [`:828`](auto-poster/src/caption.js:828), [`:924`](auto-poster/src/caption.js:924) | |
| Primary CTA `comment TOUR` | [`caption.js:552`](auto-poster/src/caption.js:552) + validator [`:22`](auto-poster/src/caption-validator.js:22) | Keyword is enforced in two places |
| Secondary CTA `DM LIST` | [`caption.js:553`](auto-poster/src/caption.js:553) | |
| `link in bio` line | [`caption.js:554`](auto-poster/src/caption.js:554) | |
| Text-to number `520.373.7839` | `video-matches.json` (historical captions) | Feeds reuse path; see §4.3 |
| Git bot identity | `.github/workflows/post.yml` (×5 jobs) | `bot@lifestyle-design.com`, cosmetic |

### 2.2 Google Drive

| What | Where | Note |
|---|---|---|
| `CITY_FOLDER_IDS` — 3 folder IDs | [`drive.js:5-9`](auto-poster/src/drive.js:5) | The headline offender |
| `"Ready to Post"` folder, resolved **by name in account root** | [`delivery.js:20`](auto-poster/src/delivery.js:20), `getOrCreateFolder` | **Collision risk — see §6.2** |

### 2.3 Distribution credentials

| What | Where | Note |
|---|---|---|
| Metricool blogId/userId/token | env — already config | Fine |
| Metricool fallback network list | [`metricool.js:81`](auto-poster/src/metricool.js:81), [`:99`](auto-poster/src/metricool.js:99) | Hardcodes `INSTAGRAM/TIKTOK/YOUTUBE` |
| **LinkedIn blogIds with live numeric fallbacks** | [`linkedin.js:43-46`](auto-poster/src/linkedin.js:43) | **Silent-leak bug — see §6.1** |
| ElevenLabs voice ID with live fallback | [`voiceover.js:35`](auto-poster/src/voiceover.js:35) | **Silent-leak bug — see §6.1** |
| YT contact email fallback | [`yt-packaging.js:57`](auto-poster/src/yt-packaging.js:57) | Same class (frozen side, listed for completeness) |

### 2.4 Niche vocabulary — the prompts

This is the largest category and the one that decides whether the output sounds like the tenant's business.

| What | Where |
|---|---|
| `CITY_NAMES` map | [`caption.js:29-33`](auto-poster/src/caption.js:29) |
| `LOCKED_HASHTAGS` (`#realestate #military #veteran #newconstruction`) | [`caption.js:35-39`](auto-poster/src/caption.js:35) |
| `LEAD_GATING_RULES` — wholly real-estate | [`caption.js:157-186`](auto-poster/src/caption.js:157) |
| `THEMED_SECTIONS_FORMAT` — "everyday living hits / amenity energy / school and numbers / buyer wins" | [`caption.js:188-210`](auto-poster/src/caption.js:188) |
| Hook-style instructions ("new construction", "toured") | [`caption.js:101-113`](auto-poster/src/caption.js:101) |
| Trial hook-angle map | [`caption.js:120-133`](auto-poster/src/caption.js:120) |
| Community KB | `communities.json` (5 communities, full facts) |
| `knownBranded` + `knownBuilders` gate lists | [`caption.js:317-334`](auto-poster/src/caption.js:317) |
| Fallback caption + fallback scripts | [`caption.js:900-946`](auto-poster/src/caption.js:900) |
| Carousel `PILLARS` (market insight / RE education / Texas lifestyle / motivation) | [`carousel-content.js:38-46`](auto-poster/src/carousel-content.js:38) |
| `KEYWORD_PAYOFFS` (MATH/LIST/CHECKLIST/REPORT) | [`carousel-content.js:63-68`](auto-poster/src/carousel-content.js:63) |
| Carousel writer identity line | [`carousel-content.js:137`](auto-poster/src/carousel-content.js:137) |
| Carousel LinkedIn caption identity | [`carousel-content.js:744`](auto-poster/src/carousel-content.js:744) |
| Critic's canonical pass/fail examples (Texas-specific) | [`carousel-content.js:~250`](auto-poster/src/carousel-content.js:250), and again in `HOOK_CLARITY_SYSTEM` |
| Voiceover `PERSONAS` ("new builds", "the home", "buyer") | [`voiceover-style.js:157-186`](auto-poster/src/voiceover-style.js:157) |
| `STORY_GUARDRAIL` (property/builder/finishes) | [`voiceover-style.js:155`](auto-poster/src/voiceover-style.js:155) |
| Vision matcher prompt ("real estate video tour") | [`matcher.js:296`](auto-poster/src/matcher.js:296) |
| LinkedIn pillars + `SYSTEM_VOICE` | [`linkedin.js:75-169`](auto-poster/src/linkedin.js:75), [`:298`](auto-poster/src/linkedin.js:298) |

### 2.5 Brand rendering

| What | Where |
|---|---|
| Palette, accent rotation, grid | `carousel-brand.json` |
| Font stacks | [`carousel-render.js:44-45`](auto-poster/src/carousel-render.js:44) |
| Footer copy "Save this for later." / "Follow for more." | [`carousel-render.js:319`](auto-poster/src/carousel-render.js:319), [`:357`](auto-poster/src/carousel-render.js:357), [`:361`](auto-poster/src/carousel-render.js:361) |

`carousel-brand.json` is already the right shape — a single source of truth with provenance. It is the model the rest of Phase 1 should copy.

### 2.6 Schedule and timezone

| What | Where |
|---|---|
| 13 cron entries across 5 city slots + 2 trial + 1 carousel | `.github/workflows/post.yml:8-28` |
| `workflow_dispatch` city enum | `post.yml:33-40` |
| **Five near-identical hardcoded jobs** | `post.yml` — see §5.5 |
| `America/Chicago` | [`carousel-content.js:74`](auto-poster/src/carousel-content.js:74), [`delivery.js:425`](auto-poster/src/delivery.js:425) |
| LinkedIn 2:00/2:30/3:00 PM ladder | [`linkedin.js:346-348`](auto-poster/src/linkedin.js:346) |
| Pillars keyed to day-of-week 0–6 | [`carousel-content.js:38-46`](auto-poster/src/carousel-content.js:38) |
| Dedupe windows (2h cooldown, 20h slot, 30d) | [`main.js:132-146`](auto-poster/src/main.js:132), [`:254`](auto-poster/src/main.js:254) |

### 2.7 Per-tenant **state** (must ship empty in the template)

`posted-log.json` · `carousel-log.json` · `video-matches.json` · `qc-blocklist.json` · `skip-list.json` · `trial-variants.json` · `linkedin-history.json` · `performance-weights.json`

These are committed to the repo and pushed back by `merge-log-push.mjs` after each run. **See §6.3** — this is the one that would silently break tenant #2 on day one.

---

## 3. Inventory — shared engine

This is the part that genuinely ports, and it is a lot. Worth saying plainly: the mechanical spine of this system is good and business-agnostic.

- **Drive I/O** — token refresh, paginated listing, download w/ size sanity check ([`drive.js`](auto-poster/src/drive.js), minus the folder map)
- **Delivery spine** — dual-channel notify, 3× exponential backoff per channel, manifest-to-Drive fallback, red-exit on total failure ([`delivery.js`](auto-poster/src/delivery.js)). Fully generic and the strongest asset here.
- **Mail discipline** — `MAIL_PREFIX` classes, RFC 2047 subject encoding, and the new `[DAILY ALERT]` separation
- **Metricool client** — upload transactions, brand discovery, scheduling, `verifyPostStatus` ([`metricool.js`](auto-poster/src/metricool.js))
- **Carousel rendering** — SVG layouts, `measure`/`wrapText`/shrink-to-fit, calibrated font factors ([`carousel-render.js`](auto-poster/src/carousel-render.js))
- **Writer/critic loop** — best-of-3, calibrated 1–10 anchors, regenerate-with-feedback, `MODEL_BUDGET` sizing for thinking+answer ([`carousel-content.js`](auto-poster/src/carousel-content.js)). The *structure* is generic; only prompt content is per-tenant.
- **Dedupe + freshness** — `content-hash.js`, `freshness.js`, `state.js` guards, skip-list/blocklist interfaces
- **Quality gates** — vertical/duration/AI-vision QC ([`quality-check.js`](auto-poster/src/quality-check.js))
- **Voiceover machinery** — TTS, tempo fitting, silence trim, ducking, burned captions with Whisper word timing
- **Analytics weighting** — `pickHookStyle` / `loadWeights` ([`analytics.js`](auto-poster/src/analytics.js))
- **Validator mechanism** — required/forbidden markers + retry instruction. The *mechanism* is shared; the *marker set* is per-tenant.
- **Leak-scanner normalization** — the Unicode-folding matcher at [`caption.js:238-290`](auto-poster/src/caption.js:238) is excellent generic infrastructure, independent of what terms it gates.

---

## 4. The proposed split

**Engine reads only from config.** Config carries:

```
tenant.json
├── identity        business name, owner email, handles, timezone, locale
├── contact         CTA keywords + payoffs, link-in-bio URL, text-to number
├── brand           palette, accents, fonts, footer copy   (existing carousel-brand.json, absorbed)
├── drive           source folder IDs by segment, ready-to-post folder ID (not name — §6.2)
├── distribution    metricool blogId/userId ref, linkedin blogIds, enabled networks
├── voice           elevenlabs voice id, persona set
├── niche
│   ├── vocabulary  business type, what the content sells, audience
│   ├── pillars     day-of-week map + angles
│   ├── kb          optional facts file (communities.json equivalent)
│   └── gating      { enabled: bool, terms: [], rationale }   ← see §5.1
├── guards          payment-figure patterns on/off, required/forbidden caption markers
├── schedule        slots, crons, posting windows, dedupe windows
└── dashboard       webhook base URL ref + secret ref
```

**The invariant test**, mirroring the workflow-env grep pattern at `tests/workflow-env.test.mjs:130`: walk `src/*.js`, fail on any business-specific literal — the brand name, the owner email, the handle, a Drive folder ID shape, a bare city name from the tenant's list, a LinkedIn/Metricool numeric ID. Same shape as the existing invariant, so it will feel native to the repo.

---

## 5. What resists tenant-izing

You asked me to say so rather than force it. Five things, in order of how much they matter.

### 5.1 The lead-gating model is not a config value — it is an architecture

Roughly a third of `caption.js` exists to *withhold searchable identifiers*: `buildGatedTerms`, `scanAndStripLeaks`, the Unicode-folding matcher, `LEAD_GATING_RULES`, the KB match, the builder-count pattern. It exists because a buyer who learns the community name goes straight to the builder and you lose the commission. **Disintermediation is the threat model.**

A cleaning company has no equivalent. There is no third party to be cut out of. The correct cleaning caption does the *opposite* — it names the service, the area, and the price band, because that is what converts.

So this is not "set `gating.terms` to `[]`". An empty gate leaves a third of the caption path running as dead weight, and the prompt still carries "the caption teases, the DM delivers" framing that would make cleaning captions coy for no reason.

**DECIDED (Peter, 2026-08-09): gating off for cleaning.** Grapefruit's captions are direct — they name the service, the area and the price band. Gating becomes a declared capability (`gating.enabled`) that switches out the whole prompt composition, not just the term list, and the cleaning tenant gets a shorter direct caption composer. Budget real work here; it is the single biggest item in Phase 1.

### 5.2 The LinkedIn pipeline does not port

`linkedin.js` recruits realtors to your brokerage — three personas (you, Steven, the company page) posting recruiting content on a timed ladder. Grapefruit is not recruiting. This should be a **pipeline off-switch** in the instance model, not a config to fill in. Do not try to generalize it into "the LinkedIn pipeline"; it is the recruiting pipeline and it belongs to one tenant.

### 5.3 The reels *ingest* is real-estate shaped

The carousel generates from nothing and ports cleanly. Reels do not:

- `price-check.js` extracts frames and asks vision to read **price / city / beds-baths** from overlays. Cleaning before/after clips have no overlays and no price. The step has nothing to read.
- `matcher.js` matches Drive footage against **original Instagram captions** in `video-matches.json`. That corpus is builder-supplied listing content. Grapefruit has no equivalent corpus.
- The KB lookup keys on community name from an overlay.

Her reels *can* come from her own Drive folder as you describe, but the front half of the pipeline (vision → overlay facts → KB match → price validation) needs replacing with something cleaning-shaped (e.g. before/after pair detection, room/service tagging), not configuring. **Recommendation:** Phase 3 proves the carousel first; reels for Grapefruit is its own phase with its own ingest.

### 5.4 The dashboard is single-tenant and it is not ours

Per your standing note, the dashboard is Manus's code. It exposes exactly three webhooks (`/api/delivery/webhook`, `/trial-webhook`, `/email-backup`) and none of them carry a tenant discriminator — cards land in one set of tabs. Tenant #2 needs either a second dashboard instance with its own `DASHBOARD_URL` or tenant-scoping in Manus's schema, which is not yours to change. Issues #48/#49 are already open against that surface.

**DECIDED (Peter, 2026-08-09): second Manus instance.** Her own `DASHBOARD_URL` and `DASHBOARD_WEBHOOK_SECRET`, no changes requested of Manus. The Phase 2 runbook gets a "stand up her dashboard" step, and the spin-up hour budget has to absorb it.

### 5.5 The workflow matrix is YAML, not config

`post.yml` hardcodes five jobs — three cities, trial, carousel — each ~40 lines of duplicated setup and secrets, with `if:` conditions matching literal cron strings. A tenant with one service area or seven does not configure this; someone rewrites the YAML. Options: a matrix strategy driven by a JSON list, or accept that the workflow is a **template artifact you hand-edit at spin-up** and document it as such. I lean toward the second for v1 — a matrix refactor on a file that five live pipelines depend on is a bigger risk than the copy-paste it saves, and it is exactly the "cloning a system with unknown bugs" hazard you named.

---

## 6. Three bugs the tenant work would otherwise inherit

These are real today. They are not tenant-izing problems; tenant-izing just makes them dangerous.

### 6.1 Hardcoded fallbacks silently route to *your* identity

```
linkedin.js:43-46   peter: Number(process.env.LINKEDIN_BLOG_ID_PETER) || 4807109
                    steven: ... || 6493212
                    lifestyle: ... || 6486275
voiceover.js:35     const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "qnTRoadmcb87J7GRHnhG"
yt-packaging.js:57  process.env.YT_CONTACT_EMAIL || "peter@lifestyledesignrealty.com"
```

A tenant repo that forgets one secret does not fail — it **posts to your LinkedIn**, or narrates in **your cloned voice**, or publishes **your email**. This is the precise opposite of your Phase 3 requirement that a missing field fail loudly at startup. Phase 1 must delete every `||` identity fallback and replace it with a startup validator.

### 6.2 "Ready to Post" is resolved by name, in the shared account's root

[`delivery.js:20`](auto-poster/src/delivery.js:20) + `getOrCreateFolder` search Drive for a folder *named* `"Ready to Post"`. You have proposed sharing the Google account across tenants in v1. If two tenants share that account, **both write finished content into the same folder**, and Grapefruit's deliveries land next to yours. Config must carry an explicit **folder ID**, not a name.

### 6.3 Cloning the template clones the state

If the template repo carries your `posted-log.json`, tenant #2 starts life believing 30 days of your videos are already posted, and the dedupe guard at [`main.js:254`](auto-poster/src/main.js:254) will filter her real footage against your history. `performance-weights.json` is worse in a quiet way: it encodes hook-style priors learned from **24 of your reels** (`wait_tease` 1.36 vs `question` 0.98). Seeding a cleaning company with real-estate hook priors is a wrong answer that looks like a working system. The template must ship these as empty/neutral, and there should be a startup assertion that a fresh instance's logs are empty on first run.

---

## 7. Cost, flagged as asked

Shared Anthropic/ElevenLabs/Google keys mean your account, your bill, per your call. What that buys per tenant per day, from the code paths:

- Carousel: Opus writer + Opus critic, up to 3 drafts → up to 6 Opus calls/day ([`carousel-content.js:26`](auto-poster/src/carousel-content.js:26), `MODEL_BUDGET` 8000)
- Reels ×5 slots: vision price-check (4 frames) + caption (+1 retry) + voiceover script + coherence check
- Trial ×2, LinkedIn ×3 personas
- ElevenLabs TTS per reel + trial

Carousel is the expensive one because it is Opus twice over with retries. I have not put a dollar figure on it because I would be guessing at your rates — but the honest framing is that a second tenant is **roughly a second full daily spend, not a marginal add**, and the carousel is the line item to watch. Worth deciding before Phase 3 whether Grapefruit's carousel critic runs on Opus or drops to Sonnet.

---

## 8. Decisions taken

Answered by Peter, 2026-08-09:

| Fork | Decision |
|---|---|
| Grapefruit brand source | **Her site exists** — palette extracted and verified. See Appendix A. |
| Dashboard | **Second Manus instance.** No changes requested of Manus. |
| Lead-gating for cleaning | **Off.** Direct captions. Gating becomes a declared capability. (§5.1) |
| Phase 3 scope | **Carousel first.** Reels ingest is a separate later phase. (§5.3) |

**Outstanding:** her service area — see Appendix A.5. Nothing else is blocked.

---

## 9. Recommended order

1. Land `audit/daily-systems`; get back to 1112/1112. **Gate — nothing below starts until this is zero.**
2. Fix §6.1–6.3 first — they are bugs on the live system, worth doing whether or not tenant #2 ever happens.
3. Phase 1 config layer + invariant test, with §5.1 (gating as a switchable capability) budgeted as real work.
4. Phase 2 template repo + runbook; hand-edited `post.yml` accepted and documented; runbook includes standing up her Manus dashboard.
5. Phase 3 Grapefruit **carousel** as proof — cleaning pillars, her palette, her service area, her Metricool. Full scenario matrix on a fresh instance, plus a startup validator proving a missing field fails loudly rather than half-running. Includes the renderer work in Appendix A.3.
6. Grapefruit reels as a separate phase with its own ingest.

---

## Appendix A — Grapefruit Cleaning Co., extracted 2026-08-09

Source: `https://grapeclean-skvabkkr.manus.space/en` (a Manus build, same as your own site).

### A.1 Palette

Tokens are authored in `oklch()`, same as your site. Converted to sRGB via the browser's own Oklab transform (canvas `fillStyle` round-trip, self-tested against `oklch(100% 0 0)` → `#FFFFFF` and `red` → `#FF0000`), then verified against what the live page actually renders.

| Role | Token | oklch | sRGB |
|---|---|---|---|
| Accent / primary | `--grapefruit`, `--primary`, `--ring` | `oklch(67.2% .19 27.5)` | **`#F45B50`** |
| Accent soft | `--grapefruit-soft`, `--accent` | `oklch(95% .03 27.5)` | `#FFE7E4` |
| Accent deep (on light) | `--accent-foreground` | `oklch(50% .16 27.5)` | `#AC312B` |
| Secondary | `--leaf` | `oklch(45% .09 160)` | `#1A6444` |
| Secondary soft | `--leaf-soft`, `--secondary` | `oklch(95% .03 160)` | `#DEF5E8` |
| Tertiary | `--sunshine` | `oklch(85% .14 85)` | `#F8C655` |
| Canvas | `--cream`, `--background` | `oklch(98.5% .006 75)` | **`#FCFAF6`** |
| Ink | `--foreground` | `oklch(28% .02 260)` | `#232933` |
| Muted ink | `--muted-foreground` | `oklch(52% .02 260)` | `#626975` |
| Border | `--border` | `oklch(91.5% .01 75)` | `#E7E2DC` |
| Surface | `--card` | `oklch(100% 0 0)` | `#FFFFFF` |

**Verification:** every rendered primary CTA on the page ("Get a Quote", "Get an Instant Quote", "Book Your Cleaning", "Try the Instant Quote Calculator") computes to background `#F45B50` on foreground `#FFFBFA`, and the screenshot confirms coral buttons on warm cream. Three ways agree, same standard as `carousel-brand.json`.

Unlike your brand, hers has **three** real accents (coral, leaf green, sunshine yellow), not one. `accentRotation` can carry genuine rotation rather than the single-entry degenerate case yours ships.

### A.2 Type

- Headline: **Plus Jakarta Sans**, weight 800
- Body: **Inter**
- No serif anywhere.

### A.3 The renderer does not port as-is — two hard blockers

This is the finding that matters most from the extraction, and it is not a config swap.

1. **Polarity is inverted.** [`carousel-render.js:39`](auto-poster/src/carousel-render.js:39) is `const BG = "#000000"` — a module constant, *not* read from the brand file, with a documented rationale about feeds compositing thumbnails against black. Your brand is dark and the canvas agrees with it. Hers is a warm cream `#FCFAF6` with dark ink. Every layout, every opacity, the grid at 0.045, and the accent-on-black contrast assumptions are built for light-on-dark. Her carousel needs the canvas to come from config **and** the layouts re-checked for contrast in the other direction.

2. **The text fitter is calibrated to the serif stack.** [`carousel-render.js:44-45`](auto-poster/src/carousel-render.js:44) hardcodes `SERIF`/`SANS`, the hook layout is explicitly "oversized serif" ([`:176`](auto-poster/src/carousel-render.js:176)), and the width factors (`BOLD_SERIF` 1.315 etc.) are measured against those exact fonts on the CI runner — the file warns that under-estimating causes overflow. Her brand is sans-only, and **neither Plus Jakarta Sans nor Inter ships on `ubuntu-latest`**. Options: install the fonts in the workflow and re-calibrate the factors, or map her to the existing DejaVu/Liberation sans stack and accept it is not her exact typeface. Either way the factors must be re-measured, not reused.

Note also that `SERIF`/`SANS` are **exported and consumed by the long-form map and infographic renderers** — so any change there touches frozen YT code. Per-tenant font resolution must be additive, not a redefinition of those exports.

### A.4 The payment guard must be off for her — and that confirms §5.1

Your `findMonthlyPaymentFigure` guard ([`caption-validator.js:95`](auto-poster/src/caption-validator.js:95)) exists because an unlicensed party quoting financing terms is a compliance problem. Grapefruit's entire funnel is the opposite: "Know your price in 60 seconds", "From $89", an instant-quote calculator on the homepage. **Publishing a price is her conversion mechanic.** So the guard is a second capability switch alongside gating — both off for her, both on for you. That is two independent switches, which is a good sign the config shape in §4 is right.

### A.5 Config values harvested

| Field | Value |
|---|---|
| Business name | Grapefruit Cleaning Co. |
| Phone | 210-254-4557 |
| Email | `Grapefruit@grapefruitclean.com` |
| Positioning | Vetted · insured · eco-friendly · 100% satisfaction guarantee |
| Price anchor | From $89 |
| Services (→ pillar source) | Residential · Commercial · **Airbnb turnovers** · Move In/Out · Deep clean · Office |

Two things to flag:

- **Service area is stated nowhere on the site.** The 210 phone number points to San Antonio, but I am not going to write an assumption into her config — this is the one field I still need confirmed.
- Her email domain is `grapefruitclean.com`, which is not the `manus.space` host the site is served from. Worth knowing which is canonical before it goes in a CTA.

**Airbnb turnovers is the standout pillar candidate** — it is a distinct audience (hosts, not homeowners), it has a sharp pain (ratings, same-day turnarounds), and it is the one service where before/after content has an obvious business stake. When Phase 3 researches cleaning-niche pillars properly, that is where I would start.
