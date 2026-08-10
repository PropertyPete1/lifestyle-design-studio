# Music bed licensing

Phase 0 for the revision-8 music bed, same standard as `STOCK-LICENSING.md`.
Verified 2026-08-10 against the live pages. Re-verify before adding a track from
a new source.

## The bar

A track may go in the Longform Music folder (Drive `1m5ls5m2CE-3FajnU4JG1V9SmJ2zmIX9y`)
only if all four hold, and the evidence is written down here:

1. Free for **commercial** use, including a monetized YouTube channel.
2. Direct download — no account, no per-use clearance, no "contact us".
3. Attribution requirements are **stated by the licensor** and satisfiable in the
   video description.
4. The track may be used as **background music under speech**, and may be
   trimmed or looped to fit a runtime.

CC0 / public domain is preferred over CC-BY: it removes the attribution failure
mode entirely. CC-BY is acceptable because the description already carries a
credits block for Pexels, so one more line costs nothing and the machinery to
emit it exists.

## Incompetech (Kevin MacLeod) — CC-BY 4.0. APPROVED, AND THE ONE IN USE.

The pipeline fetches from here. CC-BY 4.0 is itself a grant from the rights
holder to reproduce and share the work, which is the authorisation Pixabay's
terms withhold, and incompetech's pages carry no automated-access clause. The
cost is an attribution line, and the description already carries one for Pexels.

The four vendored tracks are listed in `auto-poster/src/yt-music.js` with their
ISRCs. Every URL was confirmed to return 200 with an audio payload on
2026-08-10, and every track runs longer than 22 minutes — **selected that way on
purpose**, so a 10-15 minute bed is only ever TRIMMED and never looped. Looping
would be "lengthening" under the modification clause below and would owe a more
careful disclosure than the one the credit line makes.

The pipeline fetches those four files by name and never reads a catalogue,
searches, or crawls. That is a licensing property, not an implementation detail.


https://incompetech.com/music/royalty-free/faq.html

> Licensed under Creative Commons: By Attribution 4.0

> Yes, AND you can monetize the videos. Be sure to credit me

Required credit format, from the same page — the song title, the artist, the
site, and the licence URL:

> "Title" Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0
> https://creativecommons.org/licenses/by/4.0/

Placement, verbatim: credits must sit where

> a person who wants to know where the music came from should have no difficulty
> in finding it

The video description satisfies that, and is where the Pexels credits already go.

### The modification clause, which applies to us

> can sing over, chop, splice, compress, lengthen, and add instruments

…but

> MUST make it clear in the credits which parts are yours, and which parts are
> mine.

**This binds the bed.** Ducking under narration is ordinary playback level
automation and is not a modification. Trimming or looping a track to fit a
twelve-minute runtime IS lengthening or chopping, and the pipeline does exactly
that. So the credit line states the track is used as an edited background bed
rather than implying the recording is presented whole.

## Pixabay — usable by a human, NOT fetchable by the pipeline. DEMOTED.

**This section reverses the verdict below it, and the verdict below it is left
standing so the reasoning is legible rather than tidy.** Phase 0 preferred
Pixabay because CC0-style terms remove the attribution failure mode. That is
still true, and it is a statement about USE. The build then asked the question
Phase 0 did not: how does a pipeline with no human step OBTAIN the file?

Two findings, verified 2026-08-10 against the live pages, settle it:

**1. There is no music API.** https://pixabay.com/api/docs/ documents exactly
two endpoints, `/api/` and `/api/videos/`, and describes itself as

> a RESTful interface for searching and retrieving royalty-free images and videos

Pixabay hosts music on the site; the API does not serve it. So no API key would
help, and none should be added.

**2. The full Terms prohibit automated collection.** The licence *summary* is
silent on this, which is why Phase 0 missed it. https://pixabay.com/service/terms/
§8:

> Data mining, extraction, scraping and the use of programs or robots for
> automatic data collection and/or extraction of digital data on the Service…is
> strictly prohibited for all unauthorised purposes

> Bulk, large-scale or systematic copying of Content is strictly prohibited
> unless explicit permission has been granted

A build that fetched a Pixabay track would therefore satisfy the licence on the
track and breach the terms it obtained the track under. **This is the same split
STOCK-LICENSING.md found between the Pexels content licence and the Pexels API
guidelines, arriving a second time** — and it is now a standing check rather than
a discovery: for any new source, verify the acquisition terms separately from the
use terms, because they are separate documents and only one of them is
advertised.

Pixabay music remains fine for a HUMAN to place in the Longform Music folder.
`yt-music.js` will use whatever is cached there. It just may not go and get it.

## Pixabay — no attribution required. (Superseded — see above.)

https://pixabay.com/service/license-summary/

> Use Content without having to attribute the author (although giving credit is
> always appreciated by our community!)

Prohibited, and neither applies to a background bed inside an explainer:

> sell or distribute Content (either in digital or physical form) on a Standalone
> basis

> in a misleading or deceptive way

**Preferred over Incompetech**, on the reasoning already recorded below: no
attribution means no attribution failure mode, and no modification clause to
satisfy when the bed is trimmed to a runtime. Incompetech stays as the CC-BY
fallback when Pixabay has no track that fits.

Caveat, stated by the licensor: the summary page says

> only the full Content License is legally binding

so the summary above is orientation and the full terms govern. Re-read them
before a track goes in the folder, not after.

## What is NOT settled

**YouTube's Content ID.** Phase 0 recorded that neither source addresses it. The
Incompetech FAQ does not — but a SEPARATE page does, and it says the risk is real
and current: https://incompetech.com/music/royalty-free/youtube-contentid.html

> It is becoming increasingly difficult to challenge all of the false claims
> people are filing.

> it can take months to unwind the false claim

**This corrects a claim that is repeated everywhere and is out of date.** The
widely-cited version — YouTube whitelisted MacLeod's catalogue and false claims
"dropped to zero" — traces to an incompetech blog post from 2015. The current
page does not say that, and it is the current page that governs. Anyone
researching this will meet the 2015 version first; it is wrong.

What the same page gives us is a procedure, and it is the reason the credit is
emitted automatically rather than left to a human:

> Place Credit. Somewhere in the text description, you should put a credit,
> something like: "SongTitle" by Kevin MacLeod.

> Be sure to add credits BEFORE YOU DISPUTE THE CLAIM.

> The claim will come directly from YouTube, and be released within 72 hours.

So the description block is doing two jobs: it is the CC-BY obligation, and it is
the precondition for clearing a claim in 72 hours instead of months. A video
published without it is not merely out of compliance — it has given up its own
fastest remedy.

Residual risk, accepted: a claim can still land, and the first 72 hours of a
video's life are its most valuable. This is the strongest remaining argument for
CC0, and CC0 is not reachable automatically today (see the Pixabay section). It
is worth revisiting if a CC0 source ever publishes an audio API.

Mitigation in place: the licence evidence for each track — title, ISRC, source
URL, licence and the exact credit line — is vendored in `yt-music.js` and printed
in the build report, so a dispute is a paperwork exercise rather than an
investigation.
