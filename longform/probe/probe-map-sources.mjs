#!/usr/bin/env node
/**
 * probe-map-sources.mjs — Phase 0 for illustrated B-roll. Renders nothing.
 *
 * Question: where does map geometry for San Antonio and Austin come from, such
 * that we can draw it ourselves in brand colours, ship it in a PUBLIC repo, and
 * put the result in a monetised YouTube video without a licence problem?
 *
 * "Draw it ourselves" is the constraint that decides everything. The hook for
 * video 1 calls Loop 410 and 1604 "rings", and the visual that earns its place
 * is a dark, gold-accented schematic with those two roads picked out — not a
 * screenshot of somebody's cartography with our logo in the corner. So what we
 * need is GEOMETRY (a list of coordinates) rather than TILES (pre-rendered
 * pictures in someone else's colour scheme). Tile products are rejected here on
 * fitness before licensing even comes up: you cannot restyle a PNG of a map.
 *
 * WHAT THIS CHECKS, per candidate source:
 *   - does it hand back geometry in a form we can draw (GeoJSON, not an image),
 *   - do Loop 410 and Loop 1604 actually resolve, with full ring extent,
 *   - what does the licence require of a public repo and a published video.
 *
 * Run:  node longform/probe/probe-map-sources.mjs
 * Exits non-zero if the recommended source stops answering, which is the only
 * result here that should ever block a build.
 */

const UA = "lifestyle-design-studio/longform-probe (map source evaluation)";

/** San Antonio, wide enough to contain all of 1604's outer ring. */
const SA_BBOX = { west: -98.9, south: 29.2, east: -98.2, north: 29.8 };

const TIGERWEB = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb";

function bboxParams(bbox) {
  return {
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  };
}

async function tigerQuery(service, layer, where, { returnGeometry = false } = {}) {
  const params = new URLSearchParams({
    where,
    ...bboxParams(SA_BBOX),
    outFields: "NAME",
    returnGeometry: String(returnGeometry),
    f: returnGeometry ? "geojson" : "json",
  });
  const url = `${TIGERWEB}/${service}/MapServer/${layer}/query?${params}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${service}/${layer} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${service}/${layer}: ${body.error.message}`);
  return body;
}

/** Bounding box of every coordinate in a GeoJSON FeatureCollection. */
function extentOf(featureCollection) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity, points = 0;
  for (const f of featureCollection.features || []) {
    const g = f.geometry;
    if (!g) continue;
    const parts = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
    for (const part of parts) {
      for (const [lon, lat] of part) {
        points++;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return { minLon, maxLon, minLat, maxLat, points };
}

function fmtExtent(e) {
  if (!Number.isFinite(e.minLon)) return "no geometry";
  return `lon[${e.minLon.toFixed(3)},${e.maxLon.toFixed(3)}] lat[${e.minLat.toFixed(3)},${e.maxLat.toFixed(3)}] ${e.points} pts`;
}

// ─── the candidates ─────────────────────────────────────────────────────────

/**
 * Census TIGERweb — the recommendation.
 *
 * Public domain by statute, serves GeoJSON straight out of the REST endpoint,
 * and covers roads, water, city and county outlines and military installations.
 */
async function probeTigerweb() {
  console.log("\n── Census TIGERweb (US Census Bureau) ──────────────────────");
  const findings = [];

  // Loop 410 and the northern arc of 1604 are classified "primary".
  const primary = await tigerQuery("Transportation", 2, "NAME='I- 410' OR NAME='State Loop 1604'", { returnGeometry: true });
  const byName = {};
  for (const f of primary.features || []) {
    const n = f.properties?.NAME || "?";
    (byName[n] ||= { type: "FeatureCollection", features: [] }).features.push(f);
  }
  for (const [name, fc] of Object.entries(byName)) {
    console.log(`  primary  ${name.padEnd(18)} ${fmtExtent(extentOf(fc))}`);
  }
  findings.push(`primary layer resolves: ${Object.keys(byName).join(", ") || "NOTHING"}`);

  // The southern half of 1604 is a surface road, so it lives in the secondary
  // layer. A full ring needs the union of both — the single most important
  // engineering fact this probe establishes.
  const secondary = await tigerQuery("Transportation", 4, "NAME LIKE '%1604%'", { returnGeometry: true });
  const secExtent = extentOf(secondary);
  console.log(`  secondary 1604 (all)      ${fmtExtent(secExtent)}`);

  const primary1604 = extentOf(byName["State Loop 1604"] || { features: [] });
  if (Number.isFinite(primary1604.minLat) && Number.isFinite(secExtent.minLat)) {
    const unionSouth = Math.min(primary1604.minLat, secExtent.minLat);
    const unionNorth = Math.max(primary1604.maxLat, secExtent.maxLat);
    console.log(`  → 1604 primary-only spans ${(primary1604.maxLat - primary1604.minLat).toFixed(3)}° of latitude;`);
    console.log(`    primary ∪ secondary spans ${(unionNorth - unionSouth).toFixed(3)}°. Use the union.`);
    findings.push("a full 1604 ring REQUIRES primary ∪ secondary; primary alone is the north arc only");
  }

  // Named landmarks. The user-facing labels are "Randolph", "Fort Sam",
  // "Medical Center" — check what the Census actually calls them.
  const mil = await tigerQuery("Special_Land_Use_Areas", 3, "1=1");
  const milNames = (mil.features || []).map((f) => f.attributes?.NAME);
  console.log(`  military installations:   ${milNames.join(", ") || "none"}`);
  if (milNames.some((n) => /Joint Base/i.test(n)) && !milNames.some((n) => /Randolph|Sam Houston/i.test(n))) {
    console.log("  → Randolph and Fort Sam are inside one merged 'Joint Base San Antonio' polygon.");
    console.log("    Landmark labels must be hand-authored, not derived. See MAP-LICENSING.md.");
    findings.push("landmark labels must be hand-authored — TIGER merges the bases into JBSA");
  }

  return { ok: Object.keys(byName).length > 0, findings };
}

/**
 * OpenStreetMap — legally usable, rejected on repo hygiene. See MAP-LICENSING.md.
 *
 * Not queried live: Overpass is a shared volunteer resource and this probe has
 * no question for it that the licence text does not already answer.
 */
function probeOpenStreetMap() {
  console.log("\n── OpenStreetMap / Overpass ────────────────────────────────");
  console.log("  data licence : ODbL 1.0");
  console.log("  rendered video : a 'Produced Work' — attribution only, NO share-alike (ODbL §4.5(b))");
  console.log("  vendored .geojson in this PUBLIC repo : a 'Derivative Database' — share-alike DOES attach (§4.4)");
  console.log("  → usable, and the fallback if TIGER ever fails us. Rejected as default because it");
  console.log("    puts an ODbL obligation on a committed file for coverage TIGER already provides.");
  return { ok: true, findings: ["OSM viable; share-alike attaches to vendored geometry in a public repo"] };
}

/**
 * Google Maps — rejected. Not close.
 */
function probeGoogleMaps() {
  console.log("\n── Google Maps ─────────────────────────────────────────────");
  console.log("  Attribution may not be modified, obscured or deleted — which a dark/gold restyle does.");
  console.log("  Video allowance covers promo clips ≤30s about an app's capabilities, marked");
  console.log("  'for promotional purposes only'. A monetised real-estate video is not that.");
  console.log("  → REJECTED. No scraped screenshots, per the brief and per their terms.");
  return { ok: true, findings: ["Google Maps rejected: restyling breaks attribution terms; video allowance does not cover this"] };
}

// ─── main ───────────────────────────────────────────────────────────────────

const results = [];
let tiger;
try {
  tiger = await probeTigerweb();
  results.push(...tiger.findings);
} catch (err) {
  console.error(`\n  TIGERweb FAILED: ${err.message}`);
  tiger = { ok: false, findings: [`TIGERweb unreachable: ${err.message}`] };
}
results.push(...probeOpenStreetMap().findings);
results.push(...probeGoogleMaps().findings);

console.log("\n── verdict ─────────────────────────────────────────────────");
console.log("  Census TIGERweb, vendored as simplified GeoJSON, hand-authored labels.");
console.log("  Public domain (17 U.S.C. §105) — nothing attaches to the repo or the video.");
console.log("  Attribution is wired in anyway as a courtesy citation. See MAP-LICENSING.md.\n");
for (const f of results) console.log(`  • ${f}`);

if (!tiger.ok) {
  console.error("\nFAIL: the recommended source did not answer. Fall back to OSM per MAP-LICENSING.md.");
  process.exit(1);
}
console.log("\nOK\n");
