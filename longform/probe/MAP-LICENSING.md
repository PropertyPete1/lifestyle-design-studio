# Map source licensing — the conclusion, written before the renderer was built

Settled 2026-08-08 by `probe-map-sources.mjs`. This is the Phase 0 gate for
illustrated B-roll: no map code got written until this document existed.

**Conclusion: US Census TIGER/Line, pulled from TIGERweb as GeoJSON, simplified
and vendored into the repo. Landmark labels hand-authored. No OpenStreetMap, no
Google Maps.** Attribution is emitted into the video description automatically
anyway — see [What we ship in the description](#what-we-ship-in-the-description).

---

## The constraint that decided it

The brief asked for "a stylized map with the two ring roads highlighted" in the
brand's dark-and-gold. That single sentence rules out an entire category of
option before licensing is even reached:

**We need geometry, not tiles.** A tile product hands back pre-rendered PNGs in
somebody else's colour scheme. You cannot restyle a picture of a map into
`#0A0A0C` and `#C8AA6A`, you cannot animate a ring road that is baked into a
raster, and you cannot label "Stone Oak" in Cormorant Garamond on a tile that
already has its own labels in Roboto. Every tile service — including OSM's own
`tile.openstreetmap.org` — fails on fitness, not law.

So the question is narrower than it first looks: *which source will give us a
list of coordinates for Loop 410 and Loop 1604 that we may redraw ourselves,
publish in a public repo, and put in a monetised video?*

---

## The three candidates

### 1. Google Maps — rejected

Rejected on their terms, not on ours. Two independent blockers:

- **Attribution may not be restyled.** Customers must display the attribution
  Google provides — branding, logos, copyright notices — and may not modify,
  obscure or delete it. A dark/gold restyle of their cartography does exactly
  that.
- **The video allowance does not cover us.** Their promotional-video carve-out
  is for clips of **30 seconds or less**, **about the capabilities of an
  application**, marked *"for promotional purposes only"*. A twelve-minute
  monetised real-estate video is none of those three things.

The brief said "no scraped Google Maps screenshots unless their brand guidelines
demonstrably permit it." They demonstrably do not. Closed.

### 2. OpenStreetMap — legally fine, rejected on repo hygiene

The brief proposed this as the default, and it *would* work. The licensing is
genuinely clean, and it is worth writing down precisely because the result is
better than its reputation:

| Artefact | ODbL status | Obligation |
| --- | --- | --- |
| The rendered map in the video | **Produced Work** | Attribution only |
| A `.geojson` we commit to this repo | **Derivative Database** | Attribution **+ share-alike** |

ODbL §4.5(b) is explicit that creating a Produced Work "does not create a
Derivative Database for purposes of Section 4.4" — so **share-alike never
touches the video**. That is the part people get wrong, and it is not the
problem.

The problem is the second row. Renders must be offline and deterministic — a
twelve-minute assembly cannot depend on Overpass being up, and hammering a
volunteer-run API on every build is not acceptable use. So the geometry gets
**vendored into the repo**. And `PropertyPete1/lifestyle-design-studio` **is a
public repository**, so a committed OSM-derived `.geojson` is a Derivative
Database conveyed publicly, and ODbL §4.4 share-alike attaches to that file.

That is survivable — it means a licence notice beside one data file. But it is a
standing obligation on a public repo, accepted in exchange for coverage that a
public-domain source already provides. That trade is not worth making.

**OSM remains the documented fallback** if TIGER ever stops answering, and it is
the better source for anything TIGER genuinely lacks. Nothing here is a criticism
of OSM.

### 3. Census TIGER/Line via TIGERweb — chosen

The Census Bureau's own technical documentation states it plainly:

> "Copyright protection is not available for any work of the United States
> Government (Title 17 U.S.C., Section 105). Thus, you are free to reproduce
> census materials as you see fit. We would ask, however, that you cite the
> Census Bureau as the source."

Public domain by statute. **Nothing attaches to the repo. Nothing attaches to
the video.** Citation is a courtesy the Bureau requests, not a condition — and
we honour it anyway, because a pipeline that automatically credits its sources is
one less thing to remember when the source changes.

Two caveats, both honoured:

- **TIGER/Line® is a registered trademark.** It may not be used in a product
  name. We use it to describe the data's origin only, which is the permitted use.
- **The boundaries are for statistical tabulation**, not legal land descriptions.
  Irrelevant for a stylized motion graphic; it would matter if we ever drew a
  parcel line, and we do not.

TIGERweb serves this as **GeoJSON directly out of the REST endpoint** — no
shapefile parser, no GDAL, no new runtime dependency for a repo whose only
graphics dependency is `sharp`.

---

## What the probe actually found

Legality was the easy half. The probe also established the facts that shape the
renderer, and two of them would have caused a wrong map if we had guessed:

**Loop 1604 needs two layers unioned.** In the Primary Roads layer, `State Loop
1604` spans only 0.137° of latitude — the northern freeway arc. The southern half
is a surface road and lives in the Secondary layer. Union the two and it spans
0.397°, the full ring. A renderer that queried only the "primary" layer would
draw a **C, not a ring**, in a video whose hook is the word "rings". Loop 410 has
no such split; it is interstate all the way round.

**The bases are one polygon.** TIGER carries `Joint Base San Antonio` as a single
merged installation. "Randolph" and "Fort Sam" — the names the audience actually
uses — do not exist as separate features, and "Medical Center" is not military at
all. So **landmark labels are hand-authored** in a coordinate config we own
outright, rather than derived. That is the better design regardless: it lets the
map say "Fort Sam" the way a local says it, and it keeps naming under editorial
control instead of the Census's.

**Record limits are not a concern.** `maxRecordCount` is 100,000; the twenty
features returned for 1604 are the true count, not a truncation.

---

## What we ship in the description

Attribution is emitted automatically, and deliberately over-delivers relative to
what public-domain data requires:

```
Maps in this video were drawn from US Census Bureau TIGER/Line® geographic data,
which is in the public domain.
```

Wired into the packaging step so it appears whenever a generated map is used and
is omitted when none is — a static credit line that is sometimes false is worse
than none. If the OSM fallback is ever activated, the same mechanism emits the
ODbL credit instead, including the `openstreetmap.org/copyright` URL their
guidelines require for video.

---

## Sources

- [OpenStreetMap copyright](https://www.openstreetmap.org/copyright) and the
  [OSMF attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
- [ODbL 1.0 legal code](https://opendatacommons.org/licenses/odbl/1-0/) — §4.3, §4.4, §4.5(b)
- [TIGER/Line 2023 Technical Documentation, Ch. 1](https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2023/TGRSHP2023_TechDoc_Ch1.pdf) — legal disclaimer and citation
- [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms) and [Geo Guidelines](https://about.google/brand-resource-center/products-and-services/geo-guidelines/)
