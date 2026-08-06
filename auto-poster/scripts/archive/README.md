# Archived scripts

One-time scripts that have already done their job. They are kept because they are
the record of *why* something in the live code looks the way it does — a threshold,
a font factor, a format choice. Deleting them would leave the decision without its
evidence.

**Nothing in here runs on a schedule, and nothing in here is imported by production
code.** `scripts/` one level up holds the scripts a workflow still invokes.

Several of these touch live systems. Those refuse to start unless you set
`I_UNDERSTAND_THIS_TOUCHES_LIVE=yes` — see [`../live-guard.mjs`](../live-guard.mjs).
The 🔴 column marks them.

## Carousel capability probes — issue [#11](https://github.com/PropertyPete1/lifestyle-design-studio/issues/11)

Run against the live Metricool API before any carousel feature code was written.
Every probe post was `draft:true` + `autoPublish:false`, deleted, and the deletion
verified with a follow-up GET. Nothing was published.

| Script | 🔴 | What it settled | Date |
| --- | :-: | --- | --- |
| `probe-carousel-formats.mjs` | 🔴 | Metricool exposes **no** trending-audio field via API (help centre was right: web planner only). Instagram multi-image carousels work. LinkedIn PDF document posts round-trip. | 2026-08-01 |
| `probe-carousel-media.mjs` | 🔴 | Re-probed carousels and LinkedIn documents with **real images attached** — round 1 had proved only that the flags persisted on an empty media array. Also dumped raw profile shapes to settle how LinkedIn connections are represented. | 2026-08-01 |
| `probe-carousel-reach.mjs` | 🔴 | TikTok photo carousels are reachable; YouTube rejects images outright rather than failing silently at publish; Facebook multi-image works. Mapped which brand carries which network, so fan-out targets only what exists. | 2026-08-01 |

## TikTok publish investigation — 2026-08-03

The JPEG carousel test reached `AWAITING_CONFIRMATION` instead of `PUBLISHED`, and
the question was whether that was photo-specific or account-wide.

| Script | 🔴 | What it settled | Date |
| --- | :-: | --- | --- |
| `diagnose-tiktok.mjs` |  | Read-only. `AWAITING_CONFIRMATION` is **not** photo-specific — it had happened once in 111 video posts. The property reels were the control. | 2026-08-03 |
| `probe-tiktok-publish.mjs` | 🔴 | Repeated the JPEG post with the production privacy setting (`PUBLIC_TO_EVERYONE`) to remove `SELF_ONLY` as a variable. **This is the script that put a real post on the live TikTok account.** Its header carries the lesson that produced the latch: deleting the Metricool scheduler entry does *not* retract a post the network already published — it has to be removed by hand in the app. | 2026-08-03 |

## Calibration — how the live constants were chosen

| Script | 🔴 | What it settled | Date |
| --- | :-: | --- | --- |
| `calibrate-content-hash.mjs` |  | Chose `CONTENT_DUP_THRESHOLD` empirically by measuring the two distributions it has to separate: same footage re-encoded (must land below) vs. distinct tours (must land above). Also measured how far the pipeline's own CRF 18 re-encode and caption burn move the hash. | 2026-07-31 |
| `calibrate-text-metrics.mjs` |  | Measured the renderer's width estimate against actual rasterised ink. The correction factor is font-dependent — a laptop resolves the stack to Helvetica/Georgia, the GitHub runner to DejaVu, which is wider. Calibrating on a laptop is how a headline ends up clipped on the runner. **Re-run on the runner, not locally.** | 2026-08-01 |

## Data fixes and reports

| Script | 🔴 | What it settled | Date |
| --- | :-: | --- | --- |
| `backfill-content-hashes.mjs` | 🔴 | Populated `content_hash` on historical `posted-log` entries. The dedupe guard added in PR #6 only compares entries that already carry a hash, so on the day it shipped it had zero history — which is what let a San Antonio video from 2026-07-28/29 repost on 2026-07-31. This closed the window as a data fix. Already applied; kept as the record. | 2026-08-01 |
| `scan-drive-duplicates.mjs` |  | Report only. Fingerprints every `.mp4` in a folder and lists pairs within `CONTENT_DUP_THRESHOLD` — the pairs that could reproduce the 2026-07-31 incident. | 2026-07-31 |

## Content previews — audition before anything goes out

| Script | 🔴 | What it settled | Date |
| --- | :-: | --- | --- |
| `caption-dry-run.mjs` |  | Lead-gating and the four caption fixes: no-KB fallback invents zero claims, KB overrides stale values, currency formatting, hashtag lock. Calls the Anthropic API; writes nothing. | 2026-07-13 |
| `preview-voiceover-scripts.mjs` |  | Auditions the six voiceover personas before any TTS is called or any video is touched. Calls the Anthropic API; writes nothing. | 2026-07-31 |
| `preview-linkedin-week.mjs` | 🔴 | Generates a full Mon–Sun week of LinkedIn posts through the real generator for review. **Writes into `linkedin-history.json`, which keeps only the last 7 entries — a full run evicts the entire real history**, which is the anti-repetition window the live daily post reads from. | 2026-07-22 |
| `preview-linkedin-week-local.mjs` | 🔴 | Same week, generated through the local Forge endpoint instead of the production path. **Erases `linkedin-history.json` before it starts.** That wipe used to run at module top level, so merely importing this file destroyed live state; it now lives inside `main()` behind the latch. Its `linkedin-week-preview.md` output is gitignored. | 2026-07-22 |

## Related

- Long-form YouTube Phase 0 probes live in [`longform/probe/`](../../../longform/probe/),
  documented in issue [#19](https://github.com/PropertyPete1/lifestyle-design-studio/issues/19).
  They stayed there because that issue links to the path.
