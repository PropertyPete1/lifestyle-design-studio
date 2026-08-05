# Phase 0 probes — weekly long-form YouTube engine

Three questions had to be settled before any feature code got written. These are
the scripts that settled them. Nothing here publishes anything, and none of it
is on the path to production — it exists to be run, read, and argued with.

Run them from the `Long-form Probe (Phase 0)` workflow. While that workflow
lives on a feature branch GitHub will not show the "Run workflow" button, so the
probes are triggered by markers in the commit message instead:

| marker | runs |
| --- | --- |
| `[probe-youtube]` | Metricool `youtubeData` field-by-field + Data API scope check |
| `[probe-assembly]` | full 12-minute assembly, timed on the runner |
| `[probe-4k]` | assembly probe runs 1080p **and** 4K instead of 1080p alone |

Once this merges to `main`, `workflow_dispatch` takes over and the markers stop
mattering.

## Why they are shaped this way

> **HeyGen was cut on 2026-08-05.** Peter records the on-camera segments himself,
> which removes the avatar generation step, its recurring cost, and the probe
> that measured it. The synthetic-media disclosure still applies — the B-roll
> narration uses his ElevenLabs voice clone.

**Ask the API, not the docs.** Metricool's help centre documents the web planner,
not the REST API, and the two disagree. The carousel probes learned this the
hard way, so these repeat that method: enumerate, round-trip, observe.

**Provoke the validator.** Metricool validates `youtubeData` strictly and names
the offending field in the 400. Sending a deliberately bogus value makes it
reply with the list of values it will accept — which is better documentation
than the documentation. That is how `type: video, short, unknown` was
established rather than guessed.

**A field that is accepted is not a field that is supported.** Several
`youtubeData` fields return 200 and then vanish on read-back. At publish time
that is indistinguishable from the field not existing, only harder to notice, so
every field is written and then read back before it counts as supported.

**Time the real thing.** `testsrc` encodes nothing like drone and walkthrough
footage. The assembly probe pulls actual clips out of the Drive library and
builds an actual 12-minute timeline, because a number measured on synthetic
input would not survive contact with the first real render.

## Safety

- Every Metricool probe post is `draft: true` + `autoPublish: false`, is deleted
  in a `finally` block, and the deletion is verified with a follow-up GET. A
  probe run that cannot clean up after itself exits non-zero.
- No YouTube upload happens at this phase, with or without credentials.
- Tokens are scrubbed from all output by `redact()` before anything is printed.
