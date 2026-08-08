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
export function renderMapSvg(spec) {
  const { roads, places } = loadMarket(spec.market || "san_antonio");
  const highlight = new Set(spec.highlight || []);
  const labelIds = new Set(spec.labels || []);

  const labelled = places.filter((p) => labelIds.has(p.id));

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
      const d = pathFor(f, project);
      // Drawn twice: a wide, faint pass reads as a glow at 1080p without
      // needing an SVG filter, which librsvg renders inconsistently.
      return `<path d="${d}" fill="none" stroke="${ACCENT}" stroke-width="${HIGHLIGHT_WIDTH * 3.2}" stroke-opacity="0.13" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="${d}" fill="none" stroke="${ACCENT}" stroke-width="${HIGHLIGHT_WIDTH}" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join("\n  ");

  const markerParts = [];
  const rawLabels = [];
  for (const p of labelled) {
    const [x, y] = project(p.lon, p.lat);
    markerParts.push(marker(x, y, { emphasis: p.kind === "base" || p.kind === "landmark" }));
    rawLabels.push({ x: x + 24, y: y + 11, text: p.label, kind: p.kind });
  }

  // Road badges join the SAME collision pass as the place labels. Placed
  // independently they landed on top of them — the "1604" badge sat under
  // "Stone Oak" and lost its last digit, which is a poor result for the one
  // number the shot exists to communicate.
  for (const f of roads.features) {
    if (!highlight.has(f.properties.id)) continue;
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
  <text x="${MAP_WIDTH - 40}" y="${MAP_HEIGHT - 34}" font-family="${SANS}" font-size="22" fill="${ACCENT_DIM}" fill-opacity="0.7" text-anchor="end">${esc(MAP_ATTRIBUTION)}</text>
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

export async function renderMapPng(spec) {
  return sharp(Buffer.from(renderMapSvg(spec))).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * Turn a classified segment into something drawable.
 *
 * The classifier reports WHAT it saw (routes, places); this decides what to
 * draw with it. Kept separate so the classifier stays a pure judgement about
 * language and this stays a pure judgement about pictures.
 */
export function mapSpecForSegment(segment, { market = "san_antonio", maxLabels = 6 } = {}) {
  const spec = segment?.visualSpec;
  if (!spec) return null;
  const { places } = loadMarket(market);
  const known = new Set(places.map((p) => p.id));

  const highlight = (spec.routes || []).filter(Boolean);
  const labels = (spec.places || []).filter((id) => known.has(id)).slice(0, maxLabels);
  if (highlight.length === 0 && labels.length === 0) return null;

  return {
    market,
    highlight: highlight.length ? highlight : ["loop410", "loop1604"],
    labels,
    title: null,
  };
}
