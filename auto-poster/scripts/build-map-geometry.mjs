#!/usr/bin/env node
/**
 * build-map-geometry.mjs — fetch road geometry once, commit the result.
 *
 * NOT on the render path. Renders read the vendored file this writes, because
 * a twelve-minute assembly must not depend on a REST endpoint being up, and
 * because two runs of the same script must produce the same map.
 *
 * Source is Census TIGERweb: public domain by statute, serves GeoJSON directly.
 * The reasoning, and why not OpenStreetMap, is in longform/probe/MAP-LICENSING.md.
 *
 * Run when a road changes shape, which is approximately never:
 *   node auto-poster/scripts/build-map-geometry.mjs
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "geo");
const TIGERWEB = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";

/**
 * How aggressively the centreline is thinned, in degrees.
 *
 * ~0.0004° is roughly 40m. At 1920px across a ~50km metro, one pixel is about
 * 26m, so this keeps the ring visually identical while dropping ~90% of the
 * points. The whole file has to stay small enough that committing it is not an
 * event.
 */
const SIMPLIFY_TOLERANCE = 0.00012;

/**
 * Drop fragments shorter than this, in degrees (~1.5km).
 *
 * TIGER carries on- and off-ramps and frontage stubs under the same route name
 * as the highway. Loop 1604 comes back as 19 pieces, 11 of which are two or
 * three points of slip road. Drawn in gold at a 7px stroke they are whiskers
 * sticking off the ring, and the ring is the whole point of the picture.
 */
const MIN_LINE_LENGTH = 0.015;

/**
 * What to draw, and where it comes from.
 *
 * `layers` is a list because of the single most important thing the Phase 0
 * probe found: Loop 1604's northern arc is classified a PRIMARY road and its
 * southern half is SECONDARY. Query only the primary layer and you draw a C in
 * a video whose hook is the word "rings".
 */
const ROADS = {
  san_antonio: {
    bbox: { west: -98.9, south: 29.2, east: -98.2, north: 29.8 },
    features: [
      { id: "loop410", label: "Loop 410", role: "ring", layers: [["Transportation", 2]], where: "NAME='I- 410'" },
      { id: "loop1604", label: "1604", role: "ring", layers: [["Transportation", 2], ["Transportation", 4]], where: "NAME LIKE '%1604%'" },
      { id: "us281", label: "281", role: "spoke", layers: [["Transportation", 2]], where: "NAME='US Hwy 281'" },
      { id: "i35", label: "I-35", role: "spoke", layers: [["Transportation", 2]], where: "NAME='I- 35'" },
      { id: "i10", label: "I-10", role: "spoke", layers: [["Transportation", 2]], where: "NAME='I- 10'" },
      { id: "i37", label: "I-37", role: "spoke", layers: [["Transportation", 2]], where: "NAME='I- 37'" },
    ],
  },
  austin: {
    bbox: { west: -98.1, south: 30.1, east: -97.5, north: 30.6 },
    features: [
      { id: "i35", label: "I-35", role: "spoke", layers: [["Transportation", 2]], where: "NAME='I- 35'" },
      { id: "mopac", label: "MoPac", role: "spoke", layers: [["Transportation", 2], ["Transportation", 4]], where: "NAME LIKE '%Mo Pac%' OR NAME='State Loop 1'" },
      { id: "loop360", label: "Loop 360", role: "spoke", layers: [["Transportation", 4]], where: "NAME LIKE '%360%'" },
      { id: "us183", label: "183", role: "spoke", layers: [["Transportation", 2]], where: "NAME='US Hwy 183'" },
      { id: "sh130", label: "130", role: "spoke", layers: [["Transportation", 2], ["Transportation", 4]], where: "NAME LIKE '%130%'" },
    ],
  },
};

async function fetchLayer(service, layer, where, bbox) {
  const params = new URLSearchParams({
    where,
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "NAME",
    returnGeometry: "true",
    f: "geojson",
  });
  const res = await fetch(`${TIGERWEB}/${service}/MapServer/${layer}/query?${params}`, {
    headers: { "User-Agent": "lifestyle-design-studio/build-map-geometry" },
  });
  if (!res.ok) throw new Error(`${service}/${layer} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${service}/${layer}: ${body.error.message}`);
  return body.features || [];
}

/** Every LineString in a feature list, as flat coordinate arrays. */
function toLines(features) {
  const lines = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "LineString") lines.push(g.coordinates);
    else if (g.type === "MultiLineString") lines.push(...g.coordinates);
  }
  return lines;
}

/** Perpendicular distance from p to the segment ab, in degrees. */
function perpDistance(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Douglas-Peucker, with the closed-ring case made explicit.
 *
 * DP measures every point against the chord from the first vertex to the last.
 * On a closed loop those are the same vertex and the chord is degenerate, so
 * `perpDistance` falls back to a plain radial distance from the start point.
 * That happens to land on the right answer — the farthest vertex is picked as
 * the split, and both halves are then genuinely open — but it works by
 * accident, through a fallback in a helper that nothing here promises to keep.
 * Splitting the ring up front says the same thing on purpose. It produces
 * identical output today; it is here so that it still does if `perpDistance`
 * ever grows an early return for the degenerate case.
 */
function simplify(points, tolerance) {
  if (points.length <= 2) return points;

  const first = points[0];
  const last = points[points.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) {
    let split = 1;
    let far = -1;
    for (let i = 1; i < points.length - 1; i++) {
      const d = Math.hypot(points[i][0] - first[0], points[i][1] - first[1]);
      if (d > far) { far = d; split = i; }
    }
    return [
      ...simplify(points.slice(0, split + 1), tolerance).slice(0, -1),
      ...simplify(points.slice(split), tolerance),
    ];
  }
  return dpOpen(points, tolerance);
}

function dpOpen(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDist = 0, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...dpOpen(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...dpOpen(points.slice(index), tolerance),
  ];
}

/** Total length of a polyline in degrees. Good enough to rank fragments by. */
function lineLength(line) {
  let sum = 0;
  for (let i = 1; i < line.length; i++) sum += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return sum;
}

function bboxOf(line) {
  const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Drop near-duplicate lines, by bounding box rather than by endpoints.
 *
 * TIGER carries divided highways as two carriageways a few metres apart, and at
 * a 7px gold stroke the second one is a smear rather than a picture. The
 * obvious test — do the two lines start and end in the same places — FAILS on a
 * closed loop, because the two carriageways of Loop 410 are both complete rings
 * that happen to begin at different points on the circle. That is exactly the
 * case this codebase cares about, and it shipped a visibly doubled ring before
 * this was fixed. Comparing bounding boxes catches both shapes.
 */
function dedupeParallel(lines, epsilon = 0.006) {
  const kept = [];
  for (const line of [...lines].sort((a, b) => lineLength(b) - lineLength(a))) {
    const bb = bboxOf(line);
    const duplicate = kept.some((k) => bboxOf(k).every((v, i) => Math.abs(v - bb[i]) < epsilon));
    if (!duplicate) kept.push(line);
  }
  return kept;
}

function round6(lines) {
  // Six decimals is ~10cm. Anything beyond it is file size, not geography.
  return lines.map((l) => l.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]));
}

async function buildMarket(market, spec) {
  const out = { type: "FeatureCollection", features: [] };
  for (const feat of spec.features) {
    const collected = [];
    for (const [service, layer] of feat.layers) {
      try {
        collected.push(...(await fetchLayer(service, layer, feat.where, spec.bbox)));
      } catch (err) {
        console.warn(`  ${market}/${feat.id}: ${service}/${layer} failed — ${err.message}`);
      }
    }
    const raw = toLines(collected);
    if (raw.length === 0) {
      console.warn(`  ${market}/${feat.id}: NO GEOMETRY (where: ${feat.where})`);
      continue;
    }
    const substantial = raw.filter((l) => lineLength(l) >= MIN_LINE_LENGTH);
    const lines = round6(dedupeParallel(substantial).map((l) => simplify(l, SIMPLIFY_TOLERANCE)));
    const before = raw.reduce((n, l) => n + l.length, 0);
    const after = lines.reduce((n, l) => n + l.length, 0);
    const dropped = raw.length - substantial.length;
    console.log(
      `  ${market}/${feat.id.padEnd(9)} ${String(raw.length).padStart(3)} lines → ${String(lines.length).padStart(2)}` +
        `${dropped ? ` (${dropped} stub${dropped > 1 ? "s" : ""} dropped)` : ""}, ${before} → ${after} pts`
    );
    out.features.push({
      type: "Feature",
      properties: { id: feat.id, label: feat.label, role: feat.role },
      geometry: { type: "MultiLineString", coordinates: lines },
    });
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [market, spec] of Object.entries(ROADS)) {
  console.log(`\n${market}:`);
  const fc = await buildMarket(market, spec);
  fc.attribution = "US Census Bureau TIGER/Line — public domain (17 U.S.C. §105)";
  const path = join(OUT_DIR, `${market.replace(/_/g, "-")}-roads.geojson`);
  writeFileSync(path, JSON.stringify(fc));
  const kb = (Buffer.byteLength(JSON.stringify(fc)) / 1024).toFixed(1);
  console.log(`  → ${path.split("/").slice(-1)[0]} (${kb} KB, ${fc.features.length} roads)`);
}
console.log("\nDone. Commit the .geojson files — renders read them, not the network.\n");
