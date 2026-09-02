# Every card the pipeline sends the dashboard, and what happens when the dashboard loses one

Written 2026-09-02, after the second lost card. The dashboard is Manus's code;
this is the studio-side inventory a dashboard fix can be scoped against, and
the record of what the pipeline does on its own when a card does not render.

## The two incidents

| Date | Card | What the dashboard did | Cost |
| --- | --- | --- | --- |
| 2026-08-19 | `topic_pick-2026-08-17-f60982b7` (weekly brief) | Rendered it, Peter answered it, the **decision commit never landed** on `yt-approvals.json` (the `video_review` answered in the same sitting did). | Video 2 stalled six days; recovered by hand (commit `36bdd22`), then the `record-decision` job was built for it (PR #111). |
| 2026-08-31 | `topic_pick-2026-08-31-f4a39608` (weekly brief) | Accepted the webhook (200, "dashboard notified") and **rendered it on no tab** — the reconcile sweep walked every page 2026-09-01 19:23 UTC and found no trace. | Nothing directly (the brief was for video 3), but the pipeline keyed its build stage off that unanswered card and did not assemble video 2's 35 takes for a day. Fixed on the studio side (`yt-stage.js`). |

The pattern both share: **a webhook the dashboard answered 200 is the only
acknowledgement the pipeline ever gets, and 200 has meant "rendered nowhere"
and "answered, not written back".** There is no read API on the dashboard,
so nothing on this side can ask it what it is showing or what it recorded.

A likely mechanism for Aug 31, for Manus to confirm: the dashboard was still
holding the Aug 17 topic card in its *recording* state (its recorder flow
wrote an `approve` decision with notes "35 take(s) recorded and uploaded" onto
that card at 20:40:58 UTC, 23 minutes **after** the Aug 31 card arrived), and
it shows one topic card at a time. If so, a second `topic_pick` with
`stage: null` arriving while another is in recording is dropped on the floor.

## What the dashboard accepts today

From the last smoke run that reached the endpoint (run 31562389456,
2026-08-12): `POST /api/delivery/approval-webhook` **rejects** any `kind` other
than `topic_pick`, `video_review`, `recording_kit` with HTTP 400
`Invalid kind — must be one of: topic_pick, video_review, recording_kit`. On
that run **none** of the TEST- cards rendered on any tab (`topic_pick`,
`recording_kit`, `video_review`, `held_below_bar`); the suite last passed
2026-08-08. The smoke workflow is dispatch-only and has not been run since —
it is the only instrument that can ask "does kind X render", and it should be
run again before and after any dashboard change.

Note the mismatch: the dashboard *accepts* `kind: recording_kit`, but the
pipeline sends the kit as `kind: topic_pick` with `stage: "recording_kit"` on
the **same requestId** as the brief (deliberately — a new record would read as
an unanswered brief). Whether the dashboard renders that stage envelope, and
whether it closes the topic card on receipt, is unknown from this side.

## The inventory

Every envelope goes to one of two endpoints. Approval cards carry
`{ type: "approval", requestId, kind, stage, payload, requestedAt }`
(`approvalPayload` in `auto-poster/src/delivery.js`); `stage === null` means
"a decision is being asked for", any string means "progress on a request
already decided".

### Approval cards — `/api/delivery/approval-webhook`

| # | What | `kind` | `stage` | requestId | Raised by | What Peter must do | Pipeline-side fallback if the card is lost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Weekly brief (3 topics) | `topic_pick` | `null` | new `topic_pick-…` | `yt-brief-main.js` (Monday cron) | Pick 1/2/3 or reject with notes | Email copy of the brief (Gmail, every send). **72h stall nudge** mail with the `record-decision` recovery steps (`yt-stall-nudge.js`). **Hourly reconcile sweep** mails within ~2h if the card is not visible, repeats daily (`dashboard-smoke/reconcile.mjs`). Recovery: `youtube-longform.yml → record-decision` with request_id + selection. |
| 2 | Reworked brief after a rejection | `topic_pick` | `null` | new `topic_pick-…` (old one acted `rebriefed`) | `reBriefAfterRejection` in `yt-pipeline-main.js` | Same as 1 | Same as 1 |
| 3 | Recording kit | `topic_pick` | `"recording_kit"` | **same id as the brief** | `deliverKit` (`kit-delivery.js`) | Record the takes in the recorder | Presenter gets the kit by email (fatal if that email fails — the stage is not advanced). Peter gets an owner email. `resend-kit` job re-sends. The build polls Drive four times a day; nothing waits on the card itself. |
| 4 | Held below bar | `topic_pick` | `"held_below_bar"` | same id as the brief | `deliverKitForApprovedTopic` | Nothing — informational; the next poll retries | Email copy. The request stays unacted so the next scheduled run retries the script; the run goes red if NEITHER channel took the notice. |
| 5 | No usable draft | `topic_pick` | `"no_usable_draft"` | same id as the brief | `notifyNoUsableDraft` | Nothing — the run went red | Email copy; GitHub failure mail; `script-diagnostics-<run>` artifact holds the drafts. |
| 6 | Video review | `video_review` | `null` | new `video_review-…` (carries `videoId`) | `requestReview` in `yt-publish.js` after upload | Approve (= publish) or reject with notes | Email with the private Metricool URL and the watch report. **72h stall nudge**, **hourly reconcile**, `record-decision` recovery (no selection). A rebuild marks the superseded card `superseded_by_rebuild`. |
| 7 | Reels: manual edit queued | `reel_edit` | `null` | new `reel_edit-…` | `edit-queue-scan.js` | Press Start Edit | Email under the reels prefix. **Dashboard returns 400 for this kind** (Aug 12) — these cards exist only in email until Manus adds the kind. `edit-queue-safety` tests keep them invisible to the long-form stage machine. |
| 8 | Reels: edit started / delivered / failed | `reel_edit` | `"edit_started"` / `"edit_delivered"` / `"edit_failed"` | same id as 7 | `edit-queue-advance.js`, `edit-queue-scan.js` | Nothing / review the delivery / re-press | Email. Same 400 as 7. |
| 9 | Reels: variant review | `reel_review` | `null` | new `reel_review-…` | `edit-queue-advance.js` | Pick a variant | Email. Same 400 as 7. |

### Deliveries and notices — `/api/delivery/webhook` and `/api/delivery/trial-webhook`

| # | What | Field | Raised by | Fallback if lost |
| --- | --- | --- | --- | --- |
| 10 | Reel / carousel delivery | `type: "carousel"` etc. (`deliverToOwner`) | daily poster | Email with Drive links; `posted-log.json` is the record; the smoke suite's "Deliveries tab shows what posted-log.json contains" parity test catches a silent drop. |
| 11 | Trial variant (and the long-form teaser) | trial webhook | `deliverToOwner` / `deliverTeaserToTrialTab` | Email; `trial-variants.json` parity test. Known 500 on long captions. |
| 12 | Run failure | `kind: "run_failure"` | `scripts/notify-run-failure.mjs` | GitHub's own failure email is the backstop; the dashboard returned 400 for this on 2026-08-31 19:50 (run 33432587632). |

Not a card: the presenter's kit email (`sendPresenterEmail`) and the owner
copy. Those are the channel of record for recording; the dashboard card is
the courtesy.

## What the pipeline now does on its own (this PR)

- **A newer topic card never gates a video already past its own gate.** The
  build stage is keyed off delivered kits (`inflightKits` in `yt-stage.js`),
  not off the newest brief. Pinned by `tests/yt-stage.test.mjs` with the
  exact 2026-08-31 shape.
- **One topic gate open at a time.** The Monday brief refuses to send while a
  delivered kit has no upload (`briefBlockedBy`), so the two-open-cards state
  the dashboard could not show does not recur. `FORCE=true` overrides.
- **A lost card is flagged within ~2h, not 23.** The reconcile sweep is
  hourly, gated on a cheap pre-check, and mails once per day per card
  (`reconcileAlertedAt`, its own merge group).

## What a Manus fix needs to cover

1. **Every `kind`/`stage` above either renders somewhere or is refused with a
   non-2xx.** A 200 that renders nowhere is the failure class both incidents
   share. The smoke suite (`dashboard-smoke/smoke.spec.mjs`) posts one TEST-
   card of each type and asserts it is on some tab; run it after the change.
2. **A read API.** `GET /api/delivery/approvals?state=waiting` (ids + kind +
   stage + rendered-tab) would let the reconcile sweep drop Playwright and let
   the pipeline reconcile decisions it never received. Today the only checkable
   invariant is "a waiting card is visible", and it takes a browser to check.
3. **More than one `topic_pick` at a time**, or an explicit refusal (4xx) when
   a second one arrives — never a silent drop. Under this PR the pipeline will
   not send one, but a `FORCE` brief or a re-brief after a rejection still can.
4. **Stage envelopes close the card.** When `stage: "recording_kit"` arrives on
   a requestId, the topic card for that id is done; the recorder flow should
   not write a fresh `approve` decision onto it when the upload completes (it
   overwrote `decidedAt` and `notes` on an already-decided record on Aug 31 —
   harmless because the merge keeps the earliest decision, but it is a
   decision channel being used as a progress channel).
5. **Decision write-back must be verified**, not fire-and-forget: read the
   commit back, or retry with the current SHA on a 409/422. The Aug 19 loss
   was almost certainly a stale-SHA race with a poster commit.
6. **Accept `reel_edit` and `reel_review`** (items 7–9) — those cards have
   existed only in email since the reels manual edit queue shipped.
