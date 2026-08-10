# Stock footage licensing — Pexels

Phase 0 for the revision-3 stock layer. Verified 2026-08-09 against the live
pages. This file is the written record the build was gated on; re-verify before
adding a second stock provider or before a licensing question reaches a client.

## The finding that changed the design

The spec assumed "free for commercial use, no attribution required". That is
true of the **content license** and NOT true of the **API guidelines**, which
are a separate document with separate obligations. Both bind us, because we
acquire the clips through the API.

| | Content license | API guidelines |
|---|---|---|
| Commercial use | Allowed | — |
| Attribution | **Not required** | **Required** — prominent link to Pexels |
| Photographer credit | Not required | Required "when possible" |

Ignoring the API side would have shipped a video that satisfies the license on
the clips and violates the terms we obtained them under.

## Verbatim terms

### Content license — https://www.pexels.com/license/

> All photos and videos on Pexels are free to use.

> Attribution is not required. Giving credit to the photographer or Pexels is
> not necessary but always appreciated.

Prohibited:

> Don't sell unaltered copies of a photo or video, e.g. as a poster, print or
> on a physical product without modifying it first.

> Don't redistribute or sell the photos and videos on other stock photo or
> wallpaper platforms.

> Don't use the photos or videos as part of your trade-mark, design-mark,
> trade-name, business name or service mark.

> Don't imply endorsement of your product by people or brands on the imagery.

> Identifiable people may not appear in a bad light or in a way that is
> offensive.

### API guidelines — https://www.pexels.com/api/documentation/

> Whenever you are doing an API request make sure to show a prominent link to
> Pexels.

> Always credit our photographers when possible (e.g. "Photo by John Doe on
> Pexels").

> By default, the API is rate-limited to 200 requests per hour and 20,000
> requests per month.

> You may not copy or replicate core functionality of Pexels (including making
> Pexels content available as a wallpaper app).

> Abuse of the Pexels API, including but not limited to attempting to work
> around the rate limit, will lead to termination of your API access.

## How each obligation is discharged

**Prominent link + photographer credit.** `yt-stock.js` returns a credit
manifest with every fetched clip, and `yt-packaging.js` appends a credits block
to the YouTube description. The description is the right surface: it is
permanent, public, and machine-readable, and burned-in credit text is the exact
thing revision 3 exists to remove from the picture. A video that uses no stock
emits no block, so the description never carries a dangling header.

**Not selling unaltered copies.** Every clip is brand-graded before use and cut
into a segment of an educational video. Nothing is redistributed as stock.

**No implied endorsement.** This is the live editorial risk and the reason the
vision check rejects clips whose subject reads as a testimonial: a stock family
under narration about our service could imply a client relationship that does
not exist. Stock is scenery and illustration, never a person vouching for the
business. Encoded as a rejection reason, not just a note here.

**Not a trademark.** No stock frame is used in the channel mark, thumbnail
logo, or any brand asset.

**Rate limit.** Clips are cached in Drive and content-hashed, so a rebuild of
the same script issues zero new requests. The cap that matters is 200/hour;
a 38-take script requests at most a few dozen on a cold build.

## What is NOT settled

Model releases. Pexels does not warrant that identifiable people have signed
releases, and the license only forbids showing them in a bad light. That is
fine for illustrative B-roll and would not be fine for anything that reads as
advertising a specific person's endorsement — which the no-endorsement rule
above already keeps us out of.
