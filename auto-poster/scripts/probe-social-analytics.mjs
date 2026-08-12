#!/usr/bin/env node
/**
 * probe-social-analytics.mjs — which Metricool analytics endpoints does THIS
 * account tier actually expose, and which metric fields carry real numbers?
 *
 * READ ONLY. Every call is a GET. It creates nothing, uploads nothing, deletes
 * nothing and publishes nothing.
 *
 * WHY THIS RUNS BEFORE THE COLLECTOR IS WRITTEN. Issue #83 asks for per-post
 * metrics (views, likes, comments, shares, saves) and per-platform rollups
 * (posts, views, follower count/delta) across instagram, tiktok and
 * youtube_shorts. Metricool's API is plan-gated and its public command
 * reference lists networks for post analytics as instagram, linkedin, twitter,
 * facebook, tiktok, threads, bluesky and pinterest — YOUTUBE IS NOT ON THAT
 * LIST. Writing a collector against endpoints this account cannot call would
 * produce a file full of confident nulls, which is the one outcome
 * social-telemetry.js exists to prevent. So we ask the API first.
 *
 * WHAT "AVAILABLE" HAS TO MEAN HERE. A 200 is not availability. An endpoint
 * that answers 200 with `views: null` on every post, or with the key absent
 * entirely, cannot feed a metric — and the difference between "key missing",
 * "key null" and "key is a real 0" is exactly the distinction the writer is
 * required to preserve. So for every field this reports four counts:
 *
 *     present   the key exists on the object at all
 *     nonNull   it exists and is not null/undefined
 *     nonZero   it is a number greater than zero
 *     sample    one real value, so a human can sanity-check the units
 *
 * A field that is present-but-never-nonNull across a month of real posts is
 * reported as UNPOPULATED, and belongs in the "documented, not collected" list
 * rather than in the schema.
 *
 * SECRETS. Everything printed goes through redact(). The token, user id and
 * blog ids never reach the log, in URLs or in echoed response bodies.
 */

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !BLOG_ID) {
  console.error("Missing Metricool credentials — set METRICOOL_API_TOKEN, METRICOOL_USER_ID, METRICOOL_BLOG_ID");
  process.exit(1);
}

const DAYS = Number(process.env.PROBE_DAYS || 30);

/** Never let a credential reach the log, in a URL or an echoed body. */
const redact = (s) =>
  String(s ?? "")
    .split(TOKEN).join("<TOKEN>")
    .split(USER_ID).join("<USER>")
    .split(String(BLOG_ID)).join("<BLOG>");

const iso = (d) => d.toISOString().slice(0, 19);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

const to = new Date();
const from = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

async function api(path, blogId = BLOG_ID) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE}${path}${sep}blogId=${blogId}&userId=${USER_ID}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", "X-Mc-Auth": TOKEN },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON — keep the raw text */ }
    return { status: res.status, json, text, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message || err), ms: Date.now() - started };
  }
}

/**
 * Find the array of records in a response, whatever it is wrapped in.
 * Metricool is inconsistent: some endpoints answer `{data:[...]}`, some answer a
 * bare array, some answer `{data:{...}}` with the list one level further down.
 */
function rowsOf(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (json?.data && typeof json.data === "object") {
    for (const v of Object.values(json.data)) if (Array.isArray(v)) return v;
  }
  return null;
}

/** Per-field present/nonNull/nonZero counts across rows — see the header. */
function fieldReport(rows) {
  const fields = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const [k, v] of Object.entries(row)) {
      if (!fields.has(k)) fields.set(k, { present: 0, nonNull: 0, nonZero: 0, sample: undefined, types: new Set() });
      const f = fields.get(k);
      f.present += 1;
      if (v !== null && v !== undefined) {
        f.nonNull += 1;
        f.types.add(Array.isArray(v) ? "array" : typeof v);
        if (typeof v === "number" && v > 0) f.nonZero += 1;
        if (f.sample === undefined) {
          f.sample = typeof v === "object" ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120);
        }
      }
    }
  }
  return fields;
}

function describe(label, result, { showFields = true } = {}) {
  const ok = result.status === 200;
  const rows = ok ? rowsOf(result.json) : null;

  let line = `${ok ? "  200" : `  ${String(result.status).padStart(3)}`}  ${label}`;
  if (ok && rows) line += `  → ${rows.length} row(s)`;
  else if (ok) line += `  → object`;
  console.log(line);

  if (!ok) {
    const why = redact(result.text).replace(/\s+/g, " ").slice(0, 200);
    if (why) console.log(`        ${why}`);
    return { ok: false, status: result.status, rows: 0, fields: null };
  }

  if (rows && rows.length && showFields) {
    const fields = fieldReport(rows);
    const names = [...fields.keys()].sort();
    for (const name of names) {
      const f = fields.get(name);
      const flag = f.nonNull === 0 ? "UNPOPULATED" : f.nonZero === 0 ? "all-zero   " : "populated  ";
      console.log(
        `        ${flag} ${name.padEnd(26)} present=${String(f.present).padEnd(4)} nonNull=${String(f.nonNull).padEnd(4)} nonZero=${String(f.nonZero).padEnd(4)} sample=${redact(f.sample)}`
      );
    }
    return { ok: true, status: 200, rows: rows.length, fields };
  }

  if (rows && rows.length === 0) {
    console.log("        empty array — endpoint answers, this window has no rows");
    return { ok: true, status: 200, rows: 0, fields: null };
  }

  // A non-list object: print its shape so a human can see what is on offer.
  console.log(`        ${redact(JSON.stringify(result.json)).slice(0, 400)}`);
  return { ok: true, status: 200, rows: 0, fields: null };
}

async function main() {
  console.log("=".repeat(78));
  console.log("METRICOOL ANALYTICS CAPABILITY PROBE — read-only");
  console.log(`window: ${iso(from)} → ${iso(to)} (${DAYS} days)`);
  console.log("=".repeat(78));

  // ── Which brands exist, and what is connected to them? ────────────────────
  console.log("\n## BRANDS (/admin/simpleProfiles)\n");
  const profilesRes = await fetch(`${BASE}/admin/simpleProfiles?userId=${USER_ID}`, {
    headers: { "Content-Type": "application/json", "X-Mc-Auth": TOKEN },
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))
    .catch((e) => ({ status: 0, json: null, err: String(e?.message || e) }));

  const brands = [];
  if (profilesRes.status === 200 && Array.isArray(profilesRes.json)) {
    for (const p of profilesRes.json) {
      if (p.deleted === true || p.isDemo === true) continue;
      const blogId = Number(p.id || p.blogId);
      if (!blogId) continue;
      const nets = [];
      for (const n of ["instagram", "facebook", "tiktok", "youtube", "linkedin", "twitter"]) {
        if (typeof p[n] === "string" && p[n]) nets.push(n);
      }
      brands.push({ blogId, label: String(p.label || blogId), nets });
      console.log(`  ${String(p.label || blogId).padEnd(34)} networks: ${nets.join(", ") || "(none)"}`);
    }
  } else {
    console.log(`  FAILED (${profilesRes.status}) — falling back to the default blog only`);
    brands.push({ blogId: Number(BLOG_ID), label: "default", nets: [] });
  }

  const withYouTube = brands.filter((b) => b.nets.includes("youtube"));
  const withTikTok = brands.filter((b) => b.nets.includes("tiktok"));
  console.log(`\n  ${brands.length} brand(s); ${withTikTok.length} with TikTok connected, ${withYouTube.length} with YouTube connected`);

  // ── Post-level analytics, per network ─────────────────────────────────────
  // The core question for `recent_posts`. Probed on the DEFAULT blog first;
  // per-brand coverage is checked separately below.
  console.log("\n\n## POST-LEVEL ANALYTICS — default blog\n");
  const window = `from=${iso(from)}&to=${iso(to)}&timezone=America/Chicago`;
  const postLevel = {};
  for (const network of ["instagram", "tiktok", "youtube", "facebook", "linkedin"]) {
    postLevel[`posts/${network}`] = describe(`/v2/analytics/posts/${network}`, await api(`/v2/analytics/posts/${network}?${window}`));
  }
  for (const network of ["instagram", "facebook", "tiktok"]) {
    postLevel[`reels/${network}`] = describe(`/v2/analytics/reels/${network}`, await api(`/v2/analytics/reels/${network}?${window}`));
  }
  postLevel["stories/instagram"] = describe(`/stats/instagram/stories`, await api(`/stats/instagram/stories?start=${ymd(from)}&end=${ymd(to)}`));

  // ── Profile / follower endpoints ──────────────────────────────────────────
  // The other half of the rollup: follower count and its delta.
  console.log("\n\n## PROFILE + FOLLOWER ENDPOINTS — default blog\n");
  const profile = {};
  for (const network of ["instagram", "tiktok", "youtube", "facebook"]) {
    profile[`profile/${network}`] = describe(`/v2/analytics/${network}/profile`, await api(`/v2/analytics/${network}/profile?${window}`));
  }

  // The legacy /stats surface is blog-scoped rather than network-scoped, so a
  // 200 here does not by itself say WHICH platform the number belongs to. The
  // shape dump is the point: if the series is not attributable to a platform it
  // cannot feed a per-platform rollup, however real the numbers are.
  console.log("\n\n## TIMELINE / AGGREGATION (/stats) — default blog\n");
  const stats = {};
  const statsWindow = `start=${ymd(from)}&end=${ymd(to)}`;
  for (const metric of ["followers", "impressions", "engagement", "reach", "views", "likes", "comments", "shares"]) {
    stats[`timeline/${metric}`] = describe(`/stats/timeline/${metric}`, await api(`/stats/timeline/${metric}?${statsWindow}`), { showFields: false });
  }
  for (const metric of ["followers", "impressions", "engagement", "reach"]) {
    stats[`aggregation/${metric}`] = describe(`/stats/aggregation/${metric}`, await api(`/stats/aggregation/${metric}?${statsWindow}`), { showFields: false });
  }

  // ── Per-brand coverage ────────────────────────────────────────────────────
  // The pipeline fans out to every IG-connected brand, so a collector that only
  // reads the default blog would under-report by however many satellites exist.
  console.log("\n\n## PER-BRAND COVERAGE (post-level, per network)\n");
  const perBrand = [];
  for (const brand of brands) {
    const row = { label: brand.label, blogId: brand.blogId, nets: brand.nets, results: {} };
    for (const network of ["instagram", "tiktok", "youtube"]) {
      const r = await api(`/v2/analytics/posts/${network}?${window}`, brand.blogId);
      const rows = r.status === 200 ? rowsOf(r.json) : null;
      row.results[network] = { status: r.status, rows: rows ? rows.length : null };
    }
    const reels = await api(`/v2/analytics/reels/instagram?${window}`, brand.blogId);
    const reelRows = reels.status === 200 ? rowsOf(reels.json) : null;
    row.results.reels_instagram = { status: reels.status, rows: reelRows ? reelRows.length : null };

    const fmt = (x) => (x.status === 200 ? `200/${x.rows ?? "?"}` : String(x.status));
    console.log(
      `  ${brand.label.padEnd(34)} ig=${fmt(row.results.instagram).padEnd(9)} tt=${fmt(row.results.tiktok).padEnd(9)} yt=${fmt(row.results.youtube).padEnd(9)} reels=${fmt(row.results.reels_instagram)}`
    );
    perBrand.push(row);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(78));
  console.log("VERDICT — what the collector may claim");
  console.log("=".repeat(78));

  const usable = (r) => r && r.ok;
  const say = (label, r) => {
    if (!r) return console.log(`  ${label.padEnd(28)} NOT PROBED`);
    if (!r.ok) return console.log(`  ${label.padEnd(28)} UNAVAILABLE (HTTP ${r.status}) — omit and document`);
    if (r.rows === 0) return console.log(`  ${label.padEnd(28)} REACHABLE but empty in this window — cannot confirm fields`);
    return console.log(`  ${label.padEnd(28)} AVAILABLE — ${r.rows} rows`);
  };

  console.log("\nper-post:");
  for (const key of Object.keys(postLevel)) say(key, postLevel[key]);
  console.log("\nper-platform:");
  for (const key of Object.keys(profile)) say(key, profile[key]);
  for (const key of Object.keys(stats)) say(key, stats[key]);

  // The metric fields issue #83 names, answered per endpoint that returned rows.
  console.log("\nrequested metrics, by endpoint that could carry them:");
  const WANTED = ["views", "impressions", "reach", "likes", "comments", "shares", "saved", "saves", "plays", "engagement"];
  for (const [key, r] of Object.entries({ ...postLevel })) {
    if (!usable(r) || !r.fields) continue;
    const found = [];
    for (const w of WANTED) {
      const f = r.fields.get(w);
      if (!f) continue;
      found.push(`${w}=${f.nonNull === 0 ? "UNPOPULATED" : f.nonZero === 0 ? "all-zero" : "real"}`);
    }
    console.log(`  ${key.padEnd(28)} ${found.length ? found.join("  ") : "none of the requested metric names appear"}`);
  }

  console.log("\nDone. Nothing was created, modified or published.");
}

main().catch((err) => {
  console.error(`Probe failed: ${redact(err?.message || err)}`);
  process.exit(1);
});
