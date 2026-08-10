/**
 * yt-map-render.js — brand-styled maps that read as motion graphics.
 *
 * This is NOT cartography. Nobody navigates by it. It exists to make one
 * spatial claim legible in about eight seconds on a phone: that Loop 410 and
 * 1604 are rings, that Stone Oak is outside the outer one, that Randolph is
 * over on the northeast side. Everything that does not serve that claim is
 * turned down or left out — there are no minor roads, no water, no county
 * lines, and the type is the carousel's type rather than a cartographic label
 * font, because this has to look like the same brand as the slides.
 *
 * GEOMETRY IS VENDORED, NOT FETCHED. assets/geo/*.geojson is committed, built
 * once by scripts/build-map-geometry.mjs from Census TIGER/Line. A render must
 * not depend on a REST endpoint, and two runs of the same script must produce
 * the same picture. Licensing — including why this is not OpenStreetMap — is
 * settled in longform/probe/MAP-LICENSING.md.
 *
 * RENDERED OVERSIZE ON PURPOSE. The canvas here is 2560x1440 for a 1920x1080
 * video, so the ken-burns move in yt-visual-broll.js has real pixels to pan
 * across instead of upscaling a 1080p still into softness.
 */

import sharp from "sharp";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { BRAND, SERIF, SANS, measure, BOLD_SERIF, SANS_BODY } from "./carousel-render.js";

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "geo");

/** Oversized so ken-burns has somewhere to go. 16:9, same ratio as the video. */
export const MAP_WIDTH = 2560;
export const MAP_HEIGHT = 1440;

const C = BRAND.colors;
const BG = "#000000";
const ACCENT = BRAND.accentRotation[0];
const ACCENT_DIM = C.accentDim;

/** Roads that are not the subject. Present for orientation, and no louder. */
const CONTEXT_STROKE = C.border;
const CONTEXT_WIDTH = 2.5;

/** The road being talked about. */
const HIGHLIGHT_WIDTH = 7;

/** Attribution. Public-domain data, credited anyway — see MAP-LICENSING.md. */
export const MAP_ATTRIBUTION = "US Census Bureau TIGER/Line — public domain";

const cache = new Map();

export function loadMarket(market = "san_antonio") {
  if (cache.has(market)) return cache.get(market);
  const slug = market.replace(/_/g, "-");
  const roadsPath = join(ASSET_DIR, `${slug}-roads.geojson`);
  const placesPath = join(ASSET_DIR, `${slug}-places.json`);
  if (!existsSync(roadsPath)) throw new Error(`no vendored geometry for market "${market}" (${roadsPath})`);
  const roads = JSON.parse(readFileSync(roadsPath, "utf-8"));
  const places = existsSync(placesPath) ? JSON.parse(readFileSync(placesPath, "utf-8")).places : [];
  const loaded = { roads, places };
  cache.set(market, loaded);
  return loaded;
}

// ─── projection ─────────────────────────────────────────────────────────────

/**
 * Equirectangular with a cosine correction, fitted to the drawn features.
 *
 * Web Mercator would be the reflex, but at this scale — one metro, half a
 * degree of latitude — the difference between the two is under a pixel, and
 * this is a schematic, not a survey. The cosine term is what keeps San Antonio
 * from looking horizontally stretched: at 29.5°N a degree of longitude is 87%
 * of a degree of latitude, and ignoring that is the difference between a ring
 * and an egg.
 */
export function buildProjection(bounds, { width = MAP_WIDTH, height = MAP_HEIGHT, padding = 120 } = {}) {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const lonScale = Math.cos((midLat * Math.PI) / 180);

  const spanX = (bounds.maxLon - bounds.minLon) * lonScale;
  const spanY = bounds.maxLat - bounds.minLat;
  if (spanX <= 0 || spanY <= 0) throw new Error("degenerate map bounds");

  // One scale for both axes, so the shape is never distorted to fill the frame.
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offsetX = (width - drawnW) / 2;
  const offsetY = (height - drawnH) / 2;

  return function project(lon, lat) {
    const x = offsetX + (lon - bounds.minLon) * lonScale * scale;
    // Screen y grows downward; latitude grows upward.
    const y = offsetY + (bounds.maxLat - lat) * scale;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  };
}

export function boundsOf(features) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of features) {
    const lines = f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of lines) {
      for (const [lon, lat] of line) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

function pathFor(feature, project) {
  const lines = feature.geometry.type === "MultiLineString" ? feature.geometry.coordinates : [feature.geometry.coordinates];
  return lines
    .map((line) => line.map(([lon, lat], i) => `${i === 0 ? "M" : "L"}${project(lon, lat).join(",")}`).join(""))
    .join(" ");
}

/**
 * The same road, drawn only `progress` of the way along itself.
 *
 * THIS IS THE MAP'S REVEAL UNIT. A card reveals by showing one more row; a map
 * reveals by a road ARRIVING — 1604 drawing itself around the north side while
 * Peter names it. That is the thing revision 2 was praised for and the reason
 * MAP could not stay a fallback.
 *
 * Done by truncating the projected polyline rather than with
 * stroke-dasharray/dashoffset. The dash approach needs the path's rendered
 * length, which means either asking a DOM for getTotalLength (there isn't one)
 * or estimating it — and an estimate that is 5% long leaves every road stopping
 * short of where it should, on every state, invisibly. Truncating the point list
 * is exact, needs no measurement, and renders identically in librsvg.
 *
 * MULTI-PART GEOMETRY DRAWS IN ORDER. Loop 1604 is a MultiLineString of several
 * TIGER segments; the length budget is spent across them in sequence, so the
 * ring draws as one continuous gesture instead of every fragment growing at
 * once, which reads as static noise resolving rather than a road being traced.
 */
export function partialPathFor(feature, project, progress) {
  // Non-finite progress means FINISHED, not blank. `?? 1` does not catch NaN —
  // only null and undefined — so a NaN arriving from arithmetic upstream used to
  // make the length budget NaN and return an empty path: the road silently
  // disappeared for that state, with no error. Failing toward drawing the whole
  // road keeps a bad number visible as a timing glitch instead of a missing road.
  const raw = Number(progress);
  const p = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
  if (p >= 1) return pathFor(feature, project);
  if (p <= 0) return "";

  const lines = feature.geometry.type === "MultiLineString" ? feature.geometry.coordinates : [feature.geometry.coordinates];
  const projected = lines.map((line) => line.map(([lon, lat]) => project(lon, lat)));

  const segLen = ([ax, ay], [bx, by]) => Math.hypot(bx - ax, by - ay);
  let total = 0;
  for (const line of projected) for (let i = 1; i < line.length; i++) total += segLen(line[i - 1], line[i]);
  if (total <= 0) return "";

  let budget = total * p;
  const parts = [];
  for (const line of projected) {
    if (budget <= 0) break;
    const pts = [line[0]];
    for (let i = 1; i < line.length && budget > 0; i++) {
      const l = segLen(line[i - 1], line[i]);
      if (l <= budget) {
        pts.push(line[i]);
        budget -= l;
      } else {
        // Land mid-segment so the tip advances smoothly between states rather
        // than snapping from vertex to vertex — TIGER vertices are far enough
        // apart on the rings that snapping is visible.
        const t = budget / l;
        const [ax, ay] = line[i - 1];
        const [bx, by] = line[i];
        pts.push([Math.round((ax + (bx - ax) * t) * 10) / 10, Math.round((ay + (by - ay) * t) * 10) / 10]);
        budget = 0;
      }
    }
    if (pts.length > 1) parts.push(pts.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.join(",")}`).join(""));
  }
  return parts.join(" ");
}

/**
 * The ordered things a map reveals, as the words that would name them.
 *
 * Roads first, then places. Not arbitrary: a map establishes its skeleton and
 * then hangs neighbourhoods off it, and a script describes it in that order
 * because that is the order it makes sense in. planReveals matches each of these
 * against the narration, so a script that happens to name Stone Oak before 1604
 * still gets its reveals in the spoken order — the list is the candidate set,
 * not the schedule.
 */
/**
 * The highlighted roads, in the order mapRevealLabels emits them.
 *
 * Separate from mapRevealLabels because the animator needs the IDS to key
 * progress by, and the LABELS to match against narration — and deriving one from
 * the other would mean matching a road by its display text, which is the sort of
 * join that breaks the day a label gains a suffix.
 */
/**
 * The reveal set with everything the matcher needs: what to draw, and every way
 * the narration might name it.
 *
 * Parallel to mapRevealLabels rather than replacing it, because the plain label
 * list is what the renderer titles things with and what the existing tests and
 * probes read.
 */
export function mapRevealTargets(spec) {
  const { roads, places } = loadMarket(spec.market || "san_antonio");
  const highlight = new Set(spec.highlight || []);
  const labelIds = new Set(spec.labels || []);
  return [
    ...roads.features.filter((f) => highlight.has(f.properties.id)).map((f) => ({
      kind: "road",
      id: f.properties.id,
      label: f.properties.label,
      aliases: roadAliases(f.properties.id, f.properties.label),
    })),
    ...places.filter((p) => labelIds.has(p.id)).map((p) => ({
      kind: "place",
      id: p.id,
      label: p.label,
      // A place is said by its name; no alias table earns its keep here.
      aliases: [p.label],
    })),
  ];
}

export function highlightedRoadIds(spec) {
  const { roads } = loadMarket(spec.market || "san_antonio");
  const highlight = new Set(spec.highlight || []);
  return roads.features.filter((f) => highlight.has(f.properties.id)).map((f) => f.properties.id);
}

/**
 * The ways a script actually says each road's name.
 *
 * MEASURED, NOT GUESSED. Card 7 synced 14 of 44 map reveals, and classifying every
 * miss against the real take text showed the largest fixable class was not timing
 * at all — it was vocabulary. The spec says "I-35"; Peter says "Interstate 35" in
 * s4t2 and just "35" in s5t3. normaliseWord turns the label into "i35", which
 * matches neither, and the digits path refuses two-digit numbers because "35"
 * collides with every other number in a script full of them.
 *
 * So the label carries its spoken forms. "Loop 410" is said as "410" and as "the
 * loop"; 1604 is said bare far more often than as "Loop 1604".
 *
 * Ordered longest-first so the most specific phrase wins: "interstate 35" is
 * better evidence than "35" and should be preferred when both are present.
 */
export const ROAD_ALIASES = {
  loop410: ["loop 410", "interstate 410", "410 loop", "410"],
  loop1604: ["loop 1604", "highway 1604", "1604"],
  us281: ["highway 281", "us 281", "281"],
  i35: ["interstate 35", "i 35", "ih 35", "i-35", "35"],
  i10: ["interstate 10", "i 10", "ih 10", "i-10", "10"],
  i37: ["interstate 37", "i 37", "ih 37", "i-37", "37"],
};

/** Every spoken form of a road, longest first, or just its label. */
export function roadAliases(id, label) {
  const list = ROAD_ALIASES[id] || [];
  const all = [label, ...list].filter(Boolean);
  return [...new Set(all.map((x) => String(x)))].sort((a, b) => b.length - a.length);
}

export function mapRevealLabels(spec) {
  const { roads, places } = loadMarket(spec.market || "san_antonio");
  const highlight = new Set(spec.highlight || []);
  const labelIds = new Set(spec.labels || []);
  return [
    ...roads.features.filter((f) => highlight.has(f.properties.id)).map((f) => f.properties.label),
    ...places.filter((p) => labelIds.has(p.id)).map((p) => p.label),
  ];
}

// ─── chrome ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** The carousel's faint grid, at the same density relative to the canvas. */
function grid() {
  const step = BRAND.grid.step * (MAP_WIDTH / 1080);
  const opacity = BRAND.grid.opacity;
  const parts = [];
  for (let x = step; x < MAP_WIDTH; x += step) {
    parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${MAP_HEIGHT}" stroke="${C.ink}" stroke-opacity="${opacity}" stroke-width="1"/>`);
  }
  for (let y = step; y < MAP_HEIGHT; y += step) {
    parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${MAP_WIDTH}" y2="${y.toFixed(1)}" stroke="${C.ink}" stroke-opacity="${opacity}" stroke-width="1"/>`);
  }
  return parts.join("");
}

/**
 * A label with a black backing plate.
 *
 * Type directly on a road is unreadable at 1080p on a phone. The plate is the
 * cheap fix that cartographers reach for too, and it costs nothing here
 * because the canvas is already flat black.
 */
function labelPlate(x, y, text, { size = 30, fill = C.ink, family = SANS, weight = "normal", anchor = "start" } = {}) {
  const w = measure(text, size, family === SERIF ? BOLD_SERIF : SANS_BODY);
  const padX = size * 0.42;
  const padY = size * 0.34;
  const boxX = anchor === "middle" ? x - w / 2 - padX : anchor === "end" ? x - w - padX : x - padX;
  return `
  <rect x="${(boxX).toFixed(1)}" y="${(y - size * 0.82 - padY).toFixed(1)}" width="${(w + padX * 2).toFixed(1)}" height="${(size * 1.12 + padY * 2).toFixed(1)}" rx="${(size * 0.18).toFixed(1)}" fill="${BG}" fill-opacity="0.82"/>
  <text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(text)}</text>`;
}

/** A place marker — gold dot with a soft ring, so it reads as deliberate. */
function marker(x, y, { emphasis = false } = {}) {
  const r = emphasis ? 13 : 9;
  return `
  <circle cx="${x}" cy="${y}" r="${r * 2.6}" fill="${ACCENT}" fill-opacity="0.10"/>
  <circle cx="${x}" cy="${y}" r="${r * 1.7}" fill="none" stroke="${ACCENT}" stroke-opacity="0.45" stroke-width="2"/>
  <circle cx="${x}" cy="${y}" r="${r}" fill="${ACCENT}"/>`;
}

/**
 * Push labels apart so they do not overlap.
 *
 * Neighbourhoods cluster — Live Oak, Selma and Universal City sit within a few
 * miles of each other, and at this scale their labels land on top of one
 * another and turn into a smear. This nudges colliding labels vertically until
 * they clear. Crude, deterministic, and enough for the handful of labels a
 * single map ever carries.
 */
function deconflict(labels, minGap = 46) {
  const placed = [];
  for (const l of [...labels].sort((a, b) => a.y - b.y)) {
    let y = l.y;
    let guard = 0;
    while (placed.some((p) => Math.abs(p.y - y) < minGap && Math.abs(p.x - l.x) < 300) && guard++ < 40) {
      y += minGap * 0.6;
    }
    // anchorY is where the thing actually IS; y is where its name had to go.
    placed.push({ ...l, y, anchorY: l.y });
  }
  return placed;
}

/**
 * A hairline from a marker to its displaced label.
 *
 * Deconfliction alone is not enough once places cluster. The northeast side of
 * San Antonio puts Live Oak, Selma, Universal City, Schertz and Cibolo within a
 * few miles of each other, and pushing five labels down to clear each other
 * leaves a tidy column of names sitting nowhere near the dots they belong to —
 * which is worse than an overlap, because it is legible and wrong. The leader
 * costs one thin line and makes the pairing unambiguous.
 */
function leader(x, y, anchorY) {
  if (Math.abs(y - anchorY) < 14) return "";
  return `<path d="M${(x - 14).toFixed(1)},${anchorY.toFixed(1)} L${(x - 14).toFixed(1)},${(y - 10).toFixed(1)}" stroke="${ACCENT}" stroke-width="1.5" stroke-opacity="0.35" fill="none"/>`;
}

// ─── the map ────────────────────────────────────────────────────────────────

/**
 * Render one map to SVG.
 *
 * @param {object} spec
 * @param {string} spec.market       "san_antonio" | "austin"
 * @param {string[]} spec.highlight  road ids drawn in gold
 * @param {string[]} spec.labels     place ids to label
 * @param {string} [spec.title]      the claim the map is making
 * @param {string} [spec.eyebrow]    small label above the title
 */
/**
 * Render the map, optionally part-way through its reveal.
 *
 * `state` absent means the finished map — every road drawn, every label placed —
 * which is what the still probes and the sample generator want. With a state the
 * same layout is drawn part-way through: roads truncated to their own progress,
 * places revealed up to a count.
 *
 * THE LAYOUT IS COMPUTED FROM THE SPEC, NEVER FROM THE STATE. Framing, bounds,
 * projection and label de-confliction all run over the FULL set of roads and
 * places on every state. If they were computed from what is currently visible,
 * the projection would change as roads arrived and the whole map would drift and
 * rescale under the reveals — every previously-drawn road sliding to a new
 * position, which reads as a bug and would defeat the reveal check by making
 * every state differ everywhere.
 */
export function renderMapSvg(spec, state = null) {
  const { roads, places } = loadMarket(spec.market || "san_antonio");
  const highlight = new Set(spec.highlight || []);
  const labelIds = new Set(spec.labels || []);

  const labelled = places.filter((p) => labelIds.has(p.id));

  // How much of each highlighted road is drawn, and how many places have landed.
  // No state means the finished map.
  const roadProgress = state?.roadProgress || null;
  const placesShown = state ? (state.places ?? labelled.length) : labelled.length;

  // Frame on the highlighted roads when there are any — a map of the two rings
  // should fill the screen with the two rings, not with the whole county
  // because I-10 happens to run off to the west.
  const framing = roads.features.filter((f) => highlight.has(f.properties.id));
  const bounds = expandForPlaces(boundsOf(framing.length ? framing : roads.features), labelled);
  const project = buildProjection(bounds);

  // Context first, so the subject draws over it.
  const context = roads.features
    .filter((f) => !highlight.has(f.properties.id))
    .map((f) => `<path d="${pathFor(f, project)}" fill="none" stroke="${CONTEXT_STROKE}" stroke-width="${CONTEXT_WIDTH}" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`)
    .join("\n  ");

  const subject = roads.features
    .filter((f) => highlight.has(f.properties.id))
    .map((f) => {
      const p = roadProgress ? (roadProgress[f.properties.id] ?? 0) : 1;
      if (p <= 0) return "";
      const d = partialPathFor(f, project, p);
      if (!d) return "";
      // Drawn twice: a wide, faint pass reads as a glow at 1080p without
      // needing an SVG filter, which librsvg renders inconsistently.
      return `<path d="${d}" fill="none" stroke="${ACCENT}" stroke-width="${HIGHLIGHT_WIDTH * 3.2}" stroke-opacity="0.13" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="${d}" fill="none" stroke="${ACCENT}" stroke-width="${HIGHLIGHT_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .filter(Boolean)
    .join("\n  ");

  const markerParts = [];
  const rawLabels = [];
  labelled.forEach((p, i) => {
    if (i >= placesShown) return;
    const [x, y] = project(p.lon, p.lat);
    // The MOST RECENTLY landed place carries the emphasis halo. This is the
    // closest honest equivalent to the "area fill" the brief asked for: the
    // vendored TIGER extract has no place POLYGONS, only points, so a filled
    // boundary would be a shape this data cannot support and a claim about where
    // a neighbourhood ends that we are in no position to make. A soft radial
    // around the point reads as "around here", which is true.
    const justLanded = state && i === placesShown - 1;
    if (justLanded) {
      markerParts.push(`<circle cx="${x}" cy="${y}" r="86" fill="${ACCENT}" fill-opacity="0.07"/>
  <circle cx="${x}" cy="${y}" r="52" fill="${ACCENT}" fill-opacity="0.10"/>`);
    }
    markerParts.push(marker(x, y, { emphasis: p.kind === "base" || p.kind === "landmark" }));
    rawLabels.push({ x: x + 24, y: y + 11, text: p.label, kind: p.kind });
  });

  // Road badges join the SAME collision pass as the place labels. Placed
  // independently they landed on top of them — the "1604" badge sat under
  // "Stone Oak" and lost its last digit, which is a poor result for the one
  // number the shot exists to communicate.
  for (const f of roads.features) {
    if (!highlight.has(f.properties.id)) continue;
    // The badge waits until the road it names has essentially finished drawing.
    // A "1604" plate floating beside a quarter-drawn line labels nothing.
    if (roadProgress && (roadProgress[f.properties.id] ?? 0) < 0.92) continue;
    const anchor = badgeAnchor(f, project);
    if (anchor) rawLabels.push({ x: anchor[0], y: anchor[1], text: f.properties.label, kind: "road" });
  }

  const placedLabels = deconflict(rawLabels);
  const labelParts = placedLabels.map((l) => {
    if (l.kind === "road") {
      return labelPlate(l.x, l.y, l.text, { size: 44, fill: ACCENT, family: SERIF, weight: "bold", anchor: "middle" });
    }
    const strong = l.kind === "base" || l.kind === "landmark";
    return `${leader(l.x, l.y, l.anchorY)}
  ${labelPlate(l.x, l.y, l.text, {
      size: strong ? 34 : 30,
      fill: strong ? ACCENT : C.ink,
      weight: strong ? "bold" : "normal",
    })}`;
  });

  const title = spec.title
    ? `${spec.eyebrow ? labelPlate(96, 104, spec.eyebrow, { size: 34, fill: C.muted }) : ""}
  ${labelPlate(96, spec.eyebrow ? 196 : 130, spec.title, { size: 68, family: SERIF, weight: "bold" })}
  <rect x="96" y="${spec.eyebrow ? 228 : 160}" width="${Math.min(measure(spec.title, 68, BOLD_SERIF), MAP_WIDTH - 192).toFixed(0)}" height="4" rx="2" fill="${ACCENT}"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}">
  <rect width="${MAP_WIDTH}" height="${MAP_HEIGHT}" fill="${BG}"/>
  ${grid()}
  ${context}
  ${subject}
  ${markerParts.join("\n  ")}
  ${labelParts.join("\n  ")}
  ${title}
  <text x="${MAP_WIDTH - 96}" y="${MAP_HEIGHT - 72}" font-family="${SANS}" font-size="24" fill="${ACCENT_DIM}" fill-opacity="0.75" text-anchor="end">${esc(MAP_ATTRIBUTION)}</text>
</svg>`;
}

/**
 * Where a road's name badge goes.
 *
 * A ring gets its badge on its WESTERN extreme, not its northern one. The north
 * of this map is where the neighbourhoods are — Stone Oak, Shavano Park,
 * Timberwood — so a badge placed at the top of the ring lands in the middle of
 * the labels it is competing with. The western flank of both rings is reliably
 * empty. Spokes keep the northern point, since a radial road's top end is its
 * least crowded.
 */
function badgeAnchor(feature, project) {
  const lines = feature.geometry.type === "MultiLineString" ? feature.geometry.coordinates : [feature.geometry.coordinates];
  const longest = lines.reduce((best, l) => (!best || l.length > best.length ? l : best), null);
  if (!longest || longest.length === 0) return null;

  const ring = feature.properties.role === "ring";
  let pick = longest[0];
  for (const [lon, lat] of longest) {
    if (ring ? lon < pick[0] : lat > pick[1]) pick = [lon, lat];
  }
  const [x, y] = project(pick[0], pick[1]);
  // A ring's badge sits ON the ring, its plate knocking out the stroke behind
  // it. Offsetting it into the gap between two concentric rings is worse than
  // useless — "Loop 410" floating midway between 410 and 1604 labels neither.
  return ring ? [x, y] : [x, y - 26];
}

/**
 * Widen the frame so labelled places are actually inside it.
 *
 * A map highlighting only Loop 410 frames tightly on Loop 410 — and then a
 * "Stone Oak" label, which sits well north of it, lands off-canvas. Rather
 * than dropping the label, the frame grows to hold it.
 */
function expandForPlaces(bounds, places, margin = 0.02) {
  const out = { ...bounds };
  for (const p of places) {
    out.minLon = Math.min(out.minLon, p.lon - margin);
    out.maxLon = Math.max(out.maxLon, p.lon + margin);
    out.minLat = Math.min(out.minLat, p.lat - margin);
    out.maxLat = Math.max(out.maxLat, p.lat + margin);
  }
  return out;
}

export async function renderMapPng(spec, state = null) {
  return sharp(Buffer.from(renderMapSvg(spec, state))).png({ compressionLevel: 9 }).toBuffer();
}

/** Loose match: "Stone Oak", "stone oak", "stone_oak" and "Stone Oak area" all hit. */
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve a name the WRITER wrote to something in the gazetteer.
 *
 * The writer produces prose names, not ids — it says "Stone Oak" and "1604",
 * because that is what it says out loud. Matching is deliberately forgiving on
 * punctuation and case, and deliberately NOT fuzzy beyond that: guessing that
 * "Oak Park" means "Stone Oak" would put a label on the wrong side of the city,
 * which is worse than dropping it.
 */
function resolvePlace(name, places) {
  const want = slug(name);
  if (!want) return null;
  return (
    places.find((p) => slug(p.id) === want) ||
    places.find((p) => slug(p.label) === want) ||
    places.find((p) => slug(p.label).startsWith(want) && want.length >= 5) ||
    null
  );
}

function resolveRoad(name, roads) {
  const want = slug(name);
  if (!want) return null;
  const f =
    roads.features.find((r) => slug(r.properties.id) === want) ||
    roads.features.find((r) => slug(r.properties.label) === want) ||
    // "Loop 410" -> loop410, "281" -> us281, "I-35" -> i35
    roads.features.find((r) => slug(r.properties.id).includes(want) && want.length >= 2) ||
    roads.features.find((r) => slug(r.properties.label).includes(want) && want.length >= 3);
  return f ? f.properties.id : null;
}

/**
 * Turn a validated MAP intent into something drawable, or decline.
 *
 * Declines when NOTHING the writer named could be resolved — a script about
 * Houston, or one naming a neighbourhood we have no coordinate for. That is a
 * silent fallback to footage rather than a map of the wrong city. Partial
 * matches are kept: naming four places and getting three is a good map.
 */
export function mapSpecForIntent(spec, { market = "san_antonio", maxLabels = 6 } = {}) {
  if (!spec) return null;
  let roads, places;
  try {
    ({ roads, places } = loadMarket(market));
  } catch {
    return null;
  }

  const labels = [];
  for (const name of spec.places || []) {
    const hit = resolvePlace(name, places);
    if (hit && !labels.includes(hit.id)) labels.push(hit.id);
    if (labels.length >= maxLabels) break;
  }

  const highlight = [];
  for (const name of spec.lines || []) {
    const hit = resolveRoad(name, roads);
    if (hit && !highlight.includes(hit)) highlight.push(hit);
  }

  if (highlight.length === 0 && labels.length === 0) return null;

  return {
    market,
    // With no road named, the rings are the orienting frame for this metro.
    highlight: highlight.length ? highlight : ["loop410", "loop1604"],
    labels,
    title: spec.title || null,
    eyebrow: spec.eyebrow || null,
  };
}

/**
 * One video's running memory of what its maps have already drawn.
 *
 * THE PROBLEM THIS SOLVES is not performance, it is that re-performing an
 * establishing shot reads as a stutter. Card 5 drew the 410/1604 rings from
 * scratch on all nine of its maps: by the third one the audience knows where the
 * rings are, and spending the opening of every map re-tracing them delays the
 * only new information in the shot — which was the other half of the same
 * complaint.
 *
 * So a road drawn once stays drawn for the rest of the video, and later maps open
 * from the established base and animate only their subject.
 *
 * REGION CHANGE RESETS IT. "Already on screen" is a claim about continuity, and
 * it stops being true when the map jumps somewhere else — a map of New Braunfels
 * shares no geometry with a map of the medical center, so opening it mid-draw
 * with roads inherited from a different frame would show roads at positions the
 * viewer has never seen. Overlap is measured on the projected bounds; below the
 * threshold the base is re-established from nothing.
 */
export class MapSession {
  constructor({ overlapThreshold = 0.5 } = {}) {
    this.established = new Set();
    this.lastBounds = null;
    this.overlapThreshold = overlapThreshold;
    this.regionChanges = 0;
    this.mapCount = 0;
  }

  /** Bounds of everything a spec will draw, for region comparison. */
  static boundsFor(spec) {
    const { roads, places } = loadMarket(spec.market || "san_antonio");
    const highlight = new Set(spec.highlight || []);
    const framing = roads.features.filter((f) => highlight.has(f.properties.id));
    const labelled = places.filter((p) => new Set(spec.labels || []).has(p.id));
    return expandForPlaces(boundsOf(framing.length ? framing : roads.features), labelled);
  }

  /** Fraction of the smaller box that the two boxes share. */
  static overlap(a, b) {
    if (!a || !b) return 0;
    const w = Math.max(0, Math.min(a.maxLon, b.maxLon) - Math.max(a.minLon, b.minLon));
    const h = Math.max(0, Math.min(a.maxLat, b.maxLat) - Math.max(a.minLat, b.minLat));
    const inter = w * h;
    const areaA = (a.maxLon - a.minLon) * (a.maxLat - a.minLat);
    const areaB = (b.maxLon - b.minLon) * (b.maxLat - b.minLat);
    const smaller = Math.min(areaA, areaB);
    return smaller > 0 ? inter / smaller : 0;
  }

  /**
   * Which of this spec's roads are already on screen.
   *
   * Returns an empty set for the first map, and for any map that has moved to a
   * different region — both of which must draw their own base.
   */
  establishedFor(spec) {
    const bounds = MapSession.boundsFor(spec);
    if (this.lastBounds && MapSession.overlap(bounds, this.lastBounds) < this.overlapThreshold) {
      this.established = new Set();
      this.regionChanges++;
      return new Set();
    }
    return new Set([...this.established].filter((id) => (spec.highlight || []).includes(id)));
  }

  /** Remember what this map drew, so the next one can start from it. */
  record(spec) {
    for (const id of spec.highlight || []) this.established.add(id);
    this.lastBounds = MapSession.boundsFor(spec);
    this.mapCount++;
  }
}
