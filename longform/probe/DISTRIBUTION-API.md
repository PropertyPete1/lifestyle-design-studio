# Post-publish distribution — what the YouTube API can and cannot do

Verified 2026-08-08, before the distribution module was built. Same discipline
as the map licensing and the DM correction: the platform's actual capabilities
in writing first, so no copy and no code promises a mechanic that does not
exist.

## The verdict table

| Peter asked for | API support | What we do instead |
| --- | --- | --- |
| D1 end screens | **NO** — not exposed by the Data API | One-click Studio step on the review checklist |
| D2 auto-POST the pinned comment | **YES** — `commentThreads.insert`, once the video is public | Automated in `yt-distribute.js` |
| D2 auto-PIN that comment | **NO** — pinning is not in the API | The posted comment is one click to pin in Studio; checklist says so |
| D3 playlists | **YES** — `playlists.*`, `playlistItems.*` | Fully automated: find-or-create by market/intent, add once |
| D4 community post | **NO** — no public API at all | Reported and skipped, per the instruction |
| thumbnails.set | **YES** — works while the video is still private | Automated; runs at the first sweep after approval |

Peter's own rule from the brief — "if the API doesn't support it, report and
skip" — applied to D1 and the pin half of D2 as well as D4.

## Why the comment waits, and nothing else does

`thumbnails.set` and playlist adds work on a **private** video, so they run at
the first distribution sweep after approval — before Peter even opens Studio.

A private video cannot receive comments. And this system's central invariant
(yt-publish.js) is that **no code can make a video public** — Peter publishes
in Studio, manually, always. So the comment step checks `videos.list?part=status`
each sweep and posts only once it sees `public` (or `unlisted`). Until then it
reports `waiting`, which is not an error and not a completion — the sweep
returns on the next cron.

This is also why "auto-pin ON publish" cannot literally exist here: the system
does not publish, so it has no publish event. Polling the privacy status is the
honest substitute, and it converges within one cron interval of Peter clicking
publish.

## Idempotency, because it runs on a cron

Every step checks before acting and records completion in `youtube-log.json`:

- playlist: found by title (case-insensitive) before creating; membership
  checked before adding
- comment: existing top-level comments are scanned for the same first line
  before posting
- completed steps are stored on the log entry and never re-run — a sweep over
  an already-distributed video makes **zero** API calls (asserted in tests)

## The known unknown this depends on

Everything above needs the real YouTube video id, which comes from the
Metricool post read-back (`providers[].id`, shape established by
`probe-youtube-video-id.mjs`). Whether a real **private long-form** post
carries it is unproven until video 1 exists — it is on the known-unknowns
register, and the sweep blocks with a named reason (rather than guessing) when
the id is absent.

## Sources

- End screens absent from the API: [feature request on googleapis/google-api-php-client #2514](https://github.com/googleapis/google-api-php-client/issues/2514), [Google developer forum thread](https://discuss.google.dev/t/automating-end-screen-video-recommendations-with-youtube-api/172859)
- Comment pinning absent: [commentThreads reference](https://developers.google.com/youtube/v3/docs/commentThreads) (insert/list/update only), [comments reference](https://developers.google.com/youtube/v3/docs/comments)
- Full resource list (no community posts, no end screens): [API Reference](https://developers.google.com/youtube/v3/docs)
