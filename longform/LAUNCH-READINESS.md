# Launch-readiness audit — the YouTube long-form system, as one machine

Audited 2026-08-08/09, after the five-part block merged to main (PR #51,
`aedff3f`). Everything below was verified against the merged tree, not
recalled from the work that built it.

## Verdict: **GO, with one gate and a written register**

The gate is not code. It is: **the first build must run against Peter's real
takes**, because four named things cannot be validated any other way (the
known-unknowns register, bottom). Everything that can be proven without his
footage has been proven, most of it twice, cold.

---

## 1. Triple end-to-end

`probe-full-chain.mjs` runs the complete build path — real speech synthesis,
real Whisper transcription, real matching, generated visuals, the opening
treatment, the retention edit, PIP verdicts, cadence, real ffmpeg render,
ffprobe on the artifact — as cold subprocesses with fresh work dirs.

- Three different scripts to a verified `final.mp4` (8 checks each).
- **Determinism is asserted**: the same script twice must produce the same
  video within 0.1s. It did.
- **Difference is asserted**: different scripts must produce different
  videos. This check exists because the `--script` flag was once silently
  swallowed (zsh word-splitting) and two "different" runs came out identical.
- Full pass, zero failures, then once more cold: zero again.

The writer's half ran live in CI three times (the `[probe-visuals]` runs):
the final run produced **3/3 scripts** under the seven-axis critic, one
passing all seven axes outright, with the payoff axis catching a real
factual overclaim ("twice the square footage" vs the body's own ~1.5x).

## 2. The failure matrix, through the chain

| scenario | covered by | behaviour proven |
| --- | --- | --- |
| on-camera take never recorded | full-chain E2 | build stops, take named, no video |
| voiceover take missing (peter mode) | full-chain E2 | clone fills it, fill visible, disclosure logic keyed on the RENDER |
| transcript matches no script line | full-chain E2 | stray reported, build proceeds |
| corrupt recording | full-chain E2 | surfaces loudly, never a video with a hole |
| B-roll exhausted mid-video | visual matrix + unit | `brollExhausted` flagged; starved segments never get a visual spliced (a graphic would turn the loud failure into a silently truncated sentence) |
| blank / illegible visual render | visual matrix | QC rejects at 1080p (chrome-only floor 0.55%, measured), falls back to footage |
| PIP matte bad | retention runs | rejected by the gate with named reasons; full-screen fallback |
| jump cuts / punch-ins / PIP flags | full-chain E2 | each reports "off" rather than being silently absent |
| wrong mimeType / upload never landed / multipart failure | Phase 0 probes (`probe-upload-preflight`, `probe-multipart`, `probe-media-delete`) | established live against Metricool, draft+delete pattern |
| video id missing from the post | `videoIdFromPost` + sweep | sweep BLOCKS with a named reason, never guesses |
| thumbnails.set rejected | `yt-distribute` tests | step fails alone, others proceed, retried next cron |
| end screen / pinned comment / playlist failing post-publish | `yt-distribute` tests | per-step isolation + idempotent retry (see residual risk R2) |
| approve tapped twice | `yt-approvals` unit tests | markActed idempotency |
| two pipelines sharing merge-log-push | `merge-strategies` tests + job-level concurrency groups | writers queue; merge strategies survive the race fixtures |
| backup cron firing during the primary | `youtube-longform-approvals` concurrency group, `cancel-in-progress: false` | runs queue, never overlap, never kill a build mid-upload |
| interrupted between upload and review | pipeline stage machine | markActed happens only after delivery; the next run retries from recorded state |

## 3. Config and env audit

Full read/set inventory across every workflow and every script:

- **FINDING (fixed): `YT_REFRESH_TOKEN` was set on the probe workflow and NOT
  on the pipeline job** — the job that runs the distribution sweep. The sweep
  would have skipped itself with a log warning on every scheduled run,
  forever. Exactly the `YT_NARRATION_MODE` drift class the audit was told to
  hunt. Fixed, plus a guard test asserting the pipeline job carries it.
- **FINDING (mine, false): "no concurrency groups."** A `head -6` truncation
  in the audit's own sweep hid the job-level groups that already exist and
  are better-scoped than the workflow-level one I briefly added. Reverted;
  guard test now asserts the real groups instead.
- Every `YT_*` knob read by code and set nowhere carries a safe default in
  `yt-config.js` by design (clamped, documented). Verified one by one.
- Set-but-never-read: all probe-side plumbing (`PROBE_*`, `MEDIA_PATH`,
  `MODE`, `I_UNDERSTAND_THIS_TOUCHES_LIVE`) — read by probe scripts my first
  sweep didn't glob. No dead secrets: all 15 repo secrets are consumed.
- `YT_NARRATION_MODE=peter` on all three narration-dependent jobs (guard test
  from the earlier fix still green). Segmentation venv setup on pipeline and
  dry-run jobs, best-effort with a reported fallback.

## 4. State and growth

- `youtube-log.json`: capped at 200 entries (`MAX_ENTRIES`, slice on save).
- `yt-approvals.json`: capped at 400, same pattern.
- Both merged by `merge-log-push.mjs` strategies with race-shaped unit tests.
- Recordings folders: on Drive, per-request; growth is Peter-visible and
  outside repo state. Samples dir: committed, static, 8 files.
- `TEST-` filtering: the distribution sweep skips `TEST-` requestIds
  (asserted in its filter), approvals carry `TEST_REQUEST_PREFIX` and the
  dashboard's test cards were closed out in the log history.

## 5. Notification completeness — the outcome walk

Every terminal outcome of a scheduled run, and its channel:

| outcome | notifies via |
| --- | --- |
| brief sent / kit sent | dashboard webhook (+ mail path in delivery.js) |
| topic approved but ambiguous | warning + request stays unacted (retries) |
| script held back (below bar) | held-back notice + diagnostics artifact |
| no usable draft at all | no-draft notice |
| build failed | **was: nothing but GitHub's default email. Now: `if: failure()` step posts a push through the dashboard webhook** (`notify-run-failure.mjs`), on brief and pipeline jobs. Exits 0 always so it can never mask the real failure. |
| upload failed | the run fails → same failure notice |
| review ready | requestReview → dashboard card |
| approved / rejected | dashboard action + recorded state |
| publish-verify | manual publish in Studio; the sweep's comment step independently observes the flip to public |
| post-publish extras failing | per-step warnings + persistent never-completed state in the log entry + retry every cron (see R2) |

## Residual risks, accepted with eyes open

- **R1 — graphic share.** With the cap removed, live writer runs produced
  65–76% graphic B-roll. That is the design working as specified, reported
  per video for Peter's judgment — but nobody has ever WATCHED such a video.
  Judged on video 1, by a human.
- **R2 — a distribution step that fails forever** (e.g. thumbnails.set
  rejected because the account isn't verified for custom thumbnails) retries
  every cron and shows as never-completed in the log, but does not escalate
  to a push after N failures. Small follow-up, post-launch.
- **R3 — the nightly-health system lives in the other repo** and its coverage
  of these workflows is assumed, not verified from here.

## 6. Known-unknowns register — what only video 1 can prove

1. **PIP matte quality on real footage.** The gate and fallback are proven;
   whether Peter's actual takes clear the gate is not provable on synthetic
   frames. First build reports applied/rejected per take with reasons.
2. **`providers[].id` on a real private long-form post.** The probe proved
   the shape on what it could create; the sweep blocks with a named reason if
   it is absent. If it never appears, distribution needs a manual id paste —
   one field, and the sweep takes over from there.
3. **`thumbnails.set` against the account/project as configured** (custom
   thumbnail eligibility, quota, scope). Isolated: failure is one warned step.
4. **Real retention/CTR data** — the analytics loop is explicitly the next
   engineering after a week of video-1 data, per the freeze.
5. **Runner-side segmentation throughput** — measured on M1 (8ms/frame at
   640x360), estimated 2–4x slower on Actions; not yet measured there. The
   180-minute job timeout gives ~10x headroom over the estimate.

## The freeze

Per the instruction that came with this audit: after GO, no further features
until video 1 is published and has a week of data. The next engineering is
the analytics feedback loop, designed against real retention curves, real
CTR, and real search terms. Every fix in this audit is on branch
`audit/launch-readiness`; nothing lands on main unreviewed.
