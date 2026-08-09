# Daily Systems Audit — 2026-08-09

Scope: everything that runs daily — reels (San Antonio, Austin, Dallas), trial
variants, the carousel, the manual-assist delivery flow, and their dashboard
surfaces. Bug fixes in scope, features not. The YT long-form freeze is
respected: `yt-*.js` is read where it shares a mechanism, never changed.

---

## The headline

**The trial pipeline was never dead. It ran twice a day, every day, and failed
every time — and so did most city reel slots. One cause, unreported since
2026-07-27.**

`voiceover.js` narrates using a hardcoded ElevenLabs **Professional** voice
(`qnTRoadmcb87J7GRHnhG`). The account lost the Creator-tier subscription that
voice requires. Since the first 403 at **2026-07-27T15:49Z**, every run that
needs to generate a voiceover has failed:

```
ElevenLabs TTS failed (403): {"detail":{"type":"authorization_error",
"code":"subscription_required","message":"Professional voices require a
Creator tier subscription or above.","status":"only_for_creator+"}}
```

`trial-variants.json` stopping on July 26 was the *symptom* that got noticed.
The same fault was taking down city slots the whole time.

**Why the cities looked healthier than the trial pipeline:** `processVoiceover`
calls ElevenLabs only when the source video has no genuine speech. Clips with
real speech skip TTS and post fine. Dallas's library happens to be speech-heavy,
so Dallas stayed green throughout; Austin's is not, so Austin failed most slots.
Trial variants always force a voiceover, so they failed 100%.

---

## 1. Seven-day reconstruction (scheduled runs only)

`ok/F` = succeeded/failed. `c` = cancelled. Manual dispatches excluded — this is
what the schedule alone produced.

| Day | San Antonio | Austin | Dallas | Trial | Carousel |
|---|---|---|---|---|---|
| 2026-08-02 | 4ok / 0F | **0ok / 4F** | 2ok / 0F | **0ok / 2F** | — |
| 2026-08-03 | 4ok / 0F | 2ok / 2F | 2ok / 0F | **0ok / 2F** | 1ok / 0F |
| 2026-08-04 | 4ok / 0F | **0ok / 4F** | 2ok / 0F | **0ok / 2F** | 1ok / 0F |
| 2026-08-05 | 2ok / 2F | **0ok / 4F** | 2ok / 0F | **0ok / 2F** | 1ok / 0F |
| 2026-08-06 | 0ok / 0F / 2c | 0ok / 0F / 2c | — | **0ok / 2F** | 0ok / 1F |
| 2026-08-07 | 4ok / 1F / 1c | **0ok / 6F** | 4ok / 0F | **0ok / 2F** | 1ok / 0F |
| 2026-08-08 | **0ok / 4F** | 2ok / 2F | 2ok / 0F | **0ok / 2F** | 1ok / 0F |
| 2026-08-09 | (in day) | (in day) | (in day) | **0ok / 2F** | 1ok / 0F |

- **Trial: 0 for 16 scheduled runs in 7 days. 28 consecutive failures over 14 days.**
- Every reels/trial failure sampled across all 7 days was the same ElevenLabs 403.
- The single carousel failure (2026-08-06) was unrelated and transient —
  `Internal Server Error` / `Service Unavailable`. The carousel does not narrate.
- **Every one of these failures notified nobody.** The schedule's intent is that
  each slot either posts or reports why. Every red cell above is a day where
  reality and intent differed in silence.

### Deliveries actually produced

Manual-assist delivery works. 62 posted-log entries carry a `deliveryDriveLink`;
the most recent are SA 08-04, 08-05, 08-06, 08-07 and Austin 08-08. The
delivery path itself is not implicated in the outage — it just had less to
deliver.

---

## 2. Findings

### F1 — ElevenLabs Professional voice, no Creator subscription · P0 · ACTIVE, NOT FIXED HERE

The outage above. **This one needs Peter**, not code: either restore the
Creator-tier subscription, or set the `ELEVENLABS_VOICE_ID` secret to a standard
voice id. Until then reels and trial variants keep failing — but they now say so
twice a day, by email, with both remedies named in the message.

### F2 — Nothing in the daily pipelines notified anyone · P0 · FIXED

Every failure path in `main.js`, `trial-variant-main.js` and `carousel-main.js`
was `console.error` + `exit(1)`. The only signal was GitHub's workflow-failure
mail, arriving in an inbox that already takes twenty automated messages a day.
That is why fourteen days passed.

Fixed with `src/daily-notify.js` — two channels, an `::error::` annotation that
needs no credentials and cannot fail, plus email under a **`[DAILY ALERT]`**
prefix deliberately distinct from the routine `[REELS]`/`[CAROUSEL]` traffic.
`src/failure-remedy.js` turns a diagnosis into an instruction; the real 403 body
from this outage is pinned in a test so a reworded rule cannot stop matching it.

Wired into every terminal outcome of all three entry points — including
`main.js`'s `uncaughtException` handler, which bypasses `main().catch()` and was
the last remaining way to die in total silence.

### F3 — Duplicate LinkedIn posts, four days running · P0 · FIXED

Found while tracing F1. On **2026-08-05, 06, 07 and 08** the same recruiting
topic was published **twice, ~45 minutes apart, to three real LinkedIn
accounts** (Peter, Steven, Lifestyle Design Realty).

The 20-hour guard read the log snapshot loaded at job start. The backup cron
checks out *before* the primary commits, so its snapshot cannot contain the
primary's entry no matter how correct the arithmetic. Normally the backup never
reaches the LinkedIn block — the video guard exits first — but with the primary
failing at TTS it no longer did. **F1 is what unmasked F3.**

The video path already solved this with a live remote re-read
(`checkRemoteLog`). LinkedIn now uses the same one, via a shared
`hasRecentLinkedinPost` in `state.js`. Both the bug and the fix are replayed in
`tests/linkedin-duplicate-guard.test.mjs`.

### F4 — the voice override was already configured and simply not wired up · P1 · FIXED

This is the sharpest finding in the audit and it changes what F1 probably is.

- `voiceover.js:35` reads `ELEVENLABS_VOICE_ID`, falling back to the hardcoded
  Professional voice.
- **The `ELEVENLABS_VOICE_ID` repository secret exists and has since
  2026-07-16 — eleven days before the outage began.**
- `youtube-longform.yml` passes it to its jobs (added in `76a52a6`).
- **`post.yml` never did.** Not one of the five daily jobs.

So the knob was already turned. The wire to the daily pipeline was never
connected, and those jobs kept falling back to the voice the account cannot
use. Exactly the `YT_NARRATION_MODE` / `YT_REFRESH_TOKEN` drift class, in the
other direction: wired into the long-form workflow and never back-ported to the
daily one.

Now plumbed into all four narrating jobs.

**What this means for F1:** the next scheduled run will use whatever voice id
that secret holds instead of the hardcoded Professional one. That may end the
outage on its own. **It is not proven.** The secret's value is masked, as it
should be, and no long-form run since 2026-07-27 has actually invoked TTS
through it — so there is no run anywhere that demonstrates the configured voice
is usable. Treat F1 as open until a real run narrates successfully.

### F5 — The config-drift guard only covered the long-form workflow · P1 · FIXED

`workflow-env.test.mjs` was written after those two incidents and pointed
exclusively at `youtube-longform.yml`. `post.yml` — five jobs a day, every day —
had no guard, which is why F4 survived. It is now covered, including a check
that the narrating-job list is derived from which jobs actually run a voiceover
entry point rather than hand-maintained.

### F6 — Pool exhaustion exited green and silent · P2 · FIXED

`main.js` exited `0` when the Drive folder was empty or every candidate was
filtered out. Correct exit code — an empty folder is not a crash — but it
produced a perfect-looking Actions history and no post. Both paths now alert,
with a per-reason tally of what blocked every candidate, because "0 eligible"
and "0 eligible, 40 of them blocklisted" call for different actions.

### F7 — One failing smoke check hid seven others · P2 · FIXED

The 2026-08-09 smoke run reported `3 did not run` after the approval-card test
failed — and those three are the daily side: Deliveries, Copy Caption, camera
screens. A long-form rendering bug made the entire daily half of the dashboard
unreportable while the summary still read like a complete result. `maxFailures:
0` is now explicit in `playwright.config.mjs`.

### F8 — Long-form approval cards render on no tab · P1 · REPORTED, NOT FIXED

The smoke suite posts four card types through the real webhook; all four are
accepted (HTTP 200) and **none appear on any tab**. Every one is
`kind:"topic_pick"` and only the flat `stage` field distinguishes them, so a
dashboard routing on `kind` alone sees four copies of one thing.

This is dashboard code (Manus's) and long-form, not daily. Flagged, not touched.

### Not findings — checked and cleared

- `GOOGLE_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` looked dead to a naive
  scan; they are destructured at `drive.js:27`. Live.
- `LINKEDIN_BLOG_ID_*`, `VOICEOVER_TEMPO`, `SAMPLE_OUT`, `GOOGLE_ACCESS_TOKEN`,
  `GOOGLE_WORKSPACE_CLI_TOKEN` are unset by design — each has a hardcoded
  default or is a local override.

---

## 3. Scenario matrix

| Scenario | Behaviour | Verdict |
|---|---|---|
| Candidate pool exhausted | exit 0, **now alerts** with per-reason tally | fixed (F6) |
| Every candidate blocklisted | same path, tally names the blocklist | fixed (F6) |
| Slot's primary + backup cron both fire | video: slot guard + live remote check. LinkedIn: **was broken**, now live-checked | fixed (F3) |
| Two city jobs racing on merged logs | `merge-log-push.mjs` resets to origin, merges in JSON space, 5 attempts, verifies the remote SHA advanced | already sound |
| Delivery generated, Drive upload fails | manifest written, video preserved, **now alerts** with recovery steps | fixed (F2) |
| Dashboard webhook down mid-delivery | email is an independent channel; both must fail before it throws | already sound |
| Skip pressed mid-run | skip-list read at candidate selection; an in-flight run finishes. Next run honours it | accepted, documented |
| posted-log carries a malformed entry | `validPosts` filters non-objects; guards survive | already sound |
| Metricool accepts but never publishes | `verifyPostStatus` reads back after 7 min; **now alerts**, naming that the slot will not retry | fixed (F2) |
| Video passes QC, caption pipeline fails | per-candidate catch → next candidate → exhaustion **now alerts** | fixed (F2) |
| Carousel critic unavailable | degrades to unscored, `criticUnavailable` recorded in the log | already sound |
| ElevenLabs down mid-voiceover | **this is the live outage** — now alerts with both remedies | fixed (F2), root cause open (F1) |
| Whisper fails on speech detection | fail-safe: assume speech, skip voiceover, never double voices | already sound |
| Daily jobs collide with a YT build on shared state | separate concurrency groups, but all writes go through the same JSON-space merge with retry | already sound |

---

## 4. Notification completeness

Every terminal exit in the three daily entry points, after the fix:

| Entry point | Exits | Notify | Deliberately silent |
|---|---|---|---|
| `main.js` | 10 | 7 | 3 |
| `trial-variant-main.js` | 5 | 3 | 2 |
| `carousel-main.js` | 1 | 1 | 0 |

The five silent exits are each an idempotency guard doing its job (the backup
cron finding the slot already done) or a hand-typed `FORCE_*` id with the
operator watching the run. Each is listed with its reason in
`tests/daily-notify.test.mjs`; **adding any new exit fails that test until
someone decides which of the two it is.**

---

## 5. Verification

- **Full suite: 1152 tests, 1152 pass, 0 fail.**
- **Every new guard was checked by injecting the fault it exists to catch — 8
  for 8 caught.** Removing `ELEVENLABS_VOICE_ID`, removing `GITHUB_TOKEN`,
  removing `GOOGLE_REFRESH_TOKEN`, stripping every notify call from the trial
  pipeline, breaking the carousel's import, rewording the remedy rule, deleting
  the annotation, and allowing newlines into it each turn the suite red.

### Cold run of the new failure path

The trial entry point, run with every credential removed — which is also
residual risk #2, the case where the alert channel shares a dependency with the
thing it is reporting on:

```
[TrialVariant] Generation failed: Missing Google OAuth credentials (...)
::error title=Trial variant run FAILED::Could not generate the variant: Missing Google OAuth credentials (...)
::error title=ALERTING DEGRADED::Could not email the Trial variant alert (...). This run page is the only record.
[Alert] Trial variant failed — sent via: annotation
```

It degrades **loudly**: the run page names the cause, and the fact that the
email did not go out is itself an annotation rather than a silent omission.
Before this change the same failure printed a stack trace and exited 1.
`trial-variants.json` and `posted-log.json` were byte-identical afterwards.

Two honest notes on the verification itself:

1. The **first** version of the exit-coverage guard used a fixed 30-line
   lookback, which let one exit's stated reason silently exempt an unrelated
   exit twenty lines later. Found by deleting the notify calls and watching the
   test pass anyway. Each window is now bounded by the previous exit.
2. The **first** version of the fault-injection script restored with `git
   checkout`, which reverted a file of uncommitted work and could not restore
   untracked ones — and its "did the mutation change anything" check compared a
   partial backup against the whole tree, so it passed vacuously and reported a
   green probe for a patch that was no longer there. The full suite is what
   caught it. It now restores from a byte-level backup and verifies the restore.

---

## 6. Health verdict

| Pipeline | Verdict |
|---|---|
| **Reels — Dallas** | **Healthy.** Green throughout; speech-heavy library sidesteps F1. |
| **Reels — San Antonio** | **Degraded by F1.** Posts when the clip has speech, fails otherwise. Now alerts. |
| **Reels — Austin** | **Degraded by F1, worst affected.** Most slots failing. Now alerts. |
| **Trial variants** | **Down. 28 consecutive failures.** Code is sound; blocked entirely on F1. Now alerts. |
| **Carousel** | **Healthy.** One transient failure in 7 days, self-recovered. |
| **Manual-assist delivery** | **Healthy.** Two channels, retries, manifest fallback. Failures now alert. |
| **LinkedIn** | **Was silently double-posting for 4 days. Fixed.** |
| **Dashboard — Trial tab** | **Healthy.** Renders its 2 records; empty because the pipeline is. |
| **Dashboard — Deliveries tab** | **Broken (F9).** 62 deliveries in the log, none of the recent ones on the tab. Dashboard-side. |

---

## 7. Dashboard parity — which kind of empty?

Peter's question was whether an empty tab means dead data or a rendering bug.
The smoke suite could not answer it: it proved the tabs *load*, and asserted
nothing about whether they show what the pipelines actually wrote. Two new
checks read the committed logs and look for the newest record on the tab.

**The answer is different for each tab.**

### Trial tab — dead data, rendering correctly

```
PASS  trial tab — on "Trial"
PASS  trial parity — 2 record(s) in the log; the newest is rendered (matched: 2026-07-26)
```

`trial-variants.json` holds exactly two records, both 2026-07-26, and the tab
shows them. **The tab is fine. The data is dead, and F1 is why.** When the
pipeline starts producing again the tab will fill on its own.

### Deliveries tab — NOT dead data · **F9, new finding** · P1 · REPORTED

```
PASS  delivery thumbnails — 8 loaded
FAIL  deliveries parity — 62 delivered in the log (newest austin 2026-08-08)
      and none are on the tab — RENDERING problem, not dead data
```

The old check passed because it only asked whether images were broken — eight
loaded fine. But **none of them correspond to the 62 delivered items in
`posted-log.json`, and the most recent delivery (Austin, 2026-08-08) is not on
the tab at all.** Deliveries are reaching Drive and Peter's inbox; the dashboard
is not showing the recent ones.

This is dashboard-side (Manus's code) and so is reported, not fixed — but unlike
the Trial tab it is **not** explained by the outage. Worth Peter's attention
independently.

All 7 routes load clean with no console errors, and Copy Caption returns a real
714-character caption with no internal fields leaked.

---

## 8. Residual risks, eyes open

1. **F1 is still open and is not mine to close.** Everything downstream of it
   stays degraded until the subscription or the voice id changes.
2. **The alert channel shares a dependency with the thing it reports on.** Email
   goes through the same Google OAuth token as Drive, so a dead token breaks
   delivery *and* the alert about it. Mitigated: the `::error::` annotation
   needs no credentials, the failure to email is itself annotated, and
   `failure-remedy.js` calls this case out by name.
3. **Both duplicate guards fail open.** A GitHub API blip returns "no conflict"
   rather than blocking. Deliberate — a blip must not stop the day's posting —
   but it means a determined outage could still allow a duplicate.
4. **Whole-file corruption of `posted-log.json` still fails open.** Malformed
   *entries* are handled; an unparseable file degrades to "nothing posted",
   which passes every duplicate guard. The live remote read is the mitigation,
   and it only helps while the remote copy is intact.
5. **A mid-run dashboard skip does not stop the in-flight run.** Accepted: the
   candidate is already downloaded and processed by then.
6. **F8 is unfixed and is dashboard-side.** Long-form approval cards render
   nowhere, so that pipeline's approvals depend entirely on email.
