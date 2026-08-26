# The Presenter System

Any video can be fronted by anyone Peter names. The system remembers them,
each presenter has their own quick-login code for the recorder, and their kit
email walks them from "what is this" to recording in under two minutes with no
help. Every video has a presenter; the default is Peter.

## The pieces

| Piece | Where | What it holds |
| --- | --- | --- |
| Registry | `auto-poster/presenters.json` | presenters (id, name, email, role, access code), retired-code ledger, the standing "next" assignment |
| Registry logic | `auto-poster/src/presenters.js` | add / resolve / rotate / next-assignment, all invariants |
| Guest safety | `auto-poster/src/presenter-script.js` | owner-claim sweep, neutralizer, guest writer framing, full-critic re-vet |
| Kit delivery | `auto-poster/src/kit-delivery.js` | who gets which email, TEST- inertness, supersession |
| The door | `.github/workflows/presenters.yml` → `scripts/presenter-admin.mjs` | add-presenter / assign-presenter / rotate-code / list |

## Invariants (each one is tested)

- **One presenter per email.** Duplicate adds are refused; a racing double-add
  is resolved deterministically at merge (earliest wins, loser's code retired).
- **Access codes are never reused across presenters.** Rotation retires the
  old code into a ledger; generation checks active + retired codes forever.
- **"next" is consumed exactly once, by exactly one Monday brief.** Modelled
  as a tombstone (`consumedAt`/`consumedBy`), never a nulled field, so a stale
  concurrent runner cannot resurrect it. A reworked brief inherits its
  predecessor's presenter and does not touch the standing assignment.
- **Never default silently to Peter.** An unknown name in an assignment is a
  refusal (or an add, when the input carries the full `Name <email>` form).
  A stamp naming someone missing from the registry stalls the kit, loudly.
- **No guest claims Peter's identity or experiences.** Guest scripts are
  written in team framing from the prompt, then swept: ownership claims are
  neutralized ("a family I worked with" → "we worked with", "text me" →
  "text us at 512.542.1477 framing", "I'll reply" → "we'll reply"), identity
  claims ("I'm Peter") block the kit outright, and any neutralization re-runs
  the full seven-axis critic before a kit goes out.
- **One live kit per video.** Reassignment after delivery supersedes loudly:
  the adapted script is re-vetted, the new presenter gets the kit (marked
  SUPERSEDES), the old presenter gets a "your kit is dead" notice, and the
  build matches recordings against the adapted words (`scriptAdaptedAt` keeps
  that from losing a merge).
- **TEST- presenters are fully inert.** No real mail ever (bodies are printed
  to the log), and they cannot be assigned to a real request.
- **Approve stays Peter's.** Review cards *name* the presenter; the decision
  surface and the publish path are unchanged, disclosure logic unchanged.

## Operating it

All through the **Presenters** workflow (Actions → Presenters → Run workflow),
which is also the API surface for PRIMARY later
(`POST /repos/PropertyPete1/lifestyle-design-studio/actions/workflows/presenters.yml/dispatches`).

- **Add someone**: job `add-presenter`, presenter `Name <email>`. One action;
  their code is minted immediately and travels with their first kit.
- **Assign now**: job `assign-presenter`, presenter (name/email/`Name <email>`
  to add-if-unknown), target = a `topic_pick-...` requestId or `vid-...`
  videoId. If the kit is already out this is a supersession (see above); if
  not, the pipeline generates presenter-aware when the topic is approved.
- **Assign the next video**: same job, target `next`. Consumed by the next
  Monday brief, then cleared.
- **Rotate a code**: job `rotate-code`. Old code dies instantly; the new one
  is emailed to the presenter.
- `dry_run` walks every path, writes nothing, sends nothing, bills nothing.

The kit email reaches the presenter's own inbox with: one first-timer
paragraph, the recorder link, THEIR access code, and the drill (teleprompter
reads to you · one take at a time · retake till clean · don't skip the
thumbnail take). Peter always gets the dashboard card and a copy without the
guest's code. Attribution rides the request record, `youtube-log.json`, and
the review card; the thumbnail is harvested from the presenter's own face
take automatically, because the thumbnail take is part of every kit.

## THE MANUS CONTRACT — the dashboard's half of the login gate

The studio side is done and live once merged. The recorder and its gate are
the dashboard's half. What it must implement:

**1. Source of truth.** `auto-poster/presenters.json` on `main`, read
server-side the same way the dashboard already reads/writes
`yt-approvals.json`. Never ship this file (or any access code) to the
browser. Codes are verified server-side only.

**2. The recorder URL.** Set the `RECORDER_APP_URL` secret in this repo to
the recorder page (until then kit emails fall back to
`DASHBOARD_URL/recorder`). The page prompts for a 6-digit code — nothing
else. Email-to-recording must stay under two minutes.

**3. Code check (server-side), suggested shape:**

```
POST /api/presenter/verify-code        { "code": "123456" }
  200 { "ok": true, "presenter": { "id", "name", "role" } }
  401 { "ok": false }
```

Rules: match against the ACTIVE `accessCode` of a presenter only — the
`retiredCodes` ledger is history, never valid. Codes are unique across
presenters by construction, so a code alone identifies the presenter.
Rate-limit attempts (6 digits is a convenience gate, not a vault). A
presenter with `test: true` may log in but must be clearly marked a test
session.

**4. What a presenter-scoped session may see.** Exactly the recorder for
kits assigned to them, nothing else:

- Their kits: `topic_pick` requests in `yt-approvals.json` where
  `actedAction == "kit_delivered"` and `presenter.id` (or, absent that,
  `actedResult.presenter.id`) equals the session's presenter id. The takes
  come from the recording-kit card payload (`stage: "recording_kit"`,
  `payload.takes[]`, `payload.presenter`) or from `actedResult.script`.
- The teleprompter reads `takes[].text` one take at a time, with
  `takes[].direction` shown; retakes replace; the thumbnail take is last and
  labelled optional-but-asked-for.
- Recordings upload into the request's Drive folder
  (`payload.folderPath` = `YT Recordings/<requestId>`) — the studio-side
  ingestion and matching are unchanged and need nothing new.
- A presenter session must NOT see: approval/review cards, analytics,
  deliveries, other presenters' kits, any access code, or any Approve
  control. `role: "owner"` sessions may see whatever Peter's normal
  dashboard session sees today — the code gate is additive for him, not a
  new restriction.

**5. Supersession.** A kit card whose request's `presenter.id` no longer
matches the session presenter is dead — hide it (the studio side has already
emailed both parties).
