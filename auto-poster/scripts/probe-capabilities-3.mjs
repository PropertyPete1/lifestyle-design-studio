#!/usr/bin/env node
/**
 * probe-capabilities-3.mjs — Phase 1 probe, round 3. PUBLISHES NOTHING.
 *
 * Rounds 1-2 proved photo carousels on Instagram and PDF documents on LinkedIn.
 * The distribution list then grew to TikTok and YouTube, which are unproven, so
 * they get the same treatment before any code targets them:
 *
 *   Q4  TikTok photo carousel  — TikTok has a native photo mode; does Metricool
 *       expose it? Existing code only ever sends tiktokData.contentType "VIDEO".
 *   Q5  YouTube images         — YouTube has no carousel format. Confirm the API
 *       rejects it rather than accepting and failing silently at publish.
 *   Q6  Facebook multi-image   — adjacent and free to check while we are here.
 *   Q7  Per-brand reach        — which brands actually carry which networks, so
 *       the fan-out targets only what exists.
 *
 * Same safety contract: draft:true + autoPublish:false, every draft deleted and
 * verified gone, token never printed.
 */

import sharp from "sharp";
import { createHash } from "crypto";

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const DEFAULT_BLOG = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !DEFAULT_BLOG) {
  console.error("Missing Metricool credentials");
  process.exit(1);
}

function redact(s) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return "";
  return str.split(TOKEN).join("<REDACTED>").split(USER_ID).join("<USER_ID>").split(String(DEFAULT_BLOG)).join("<BLOG_ID>");
}

const authParams = (blogId = DEFAULT_BLOG) => `blogId=${blogId}&userId=${USER_ID}`;
const authHeaders = () => ({ "Content-Type": "application/json", "X-Mc-Auth": TOKEN });

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const created = [];

async function createDraft(body, label, blogId = DEFAULT_BLOG) {
  const res = await api(`/v2/scheduler/posts?${authParams(blogId)}`, { method: "POST", body: JSON.stringify(body) });
  const id = res.json?.data?.id || res.json?.id;
  if (id) created.push({ id, blogId, label });
  return { ...res, id };
}

async function cleanup() {
  console.log(`\n=== CLEANUP: deleting ${created.length} probe drafts ===`);
  for (const d of created) {
    try {
      const res = await api(`/v2/scheduler/posts/${d.id}?${authParams(d.blogId)}`, { method: "DELETE" });
      const check = await api(`/v2/scheduler/posts/${d.id}?${authParams(d.blogId)}`);
      const gone = check.status === 404 || check.status === 400 || !check.json?.data;
      console.log(`  [cleanup] ${d.label} id=${d.id}: delete=${res.status} verified_gone=${gone}`);
    } catch (e) {
      console.error(`  [cleanup] FAILED for ${d.id}: ${redact(e.message)}`);
    }
  }
}

const futureDateTime = (days = 7) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19);

async function uploadImage(buf, blogId = DEFAULT_BLOG) {
  const sha256b64 = createHash("sha256").update(buf).digest("base64");
  const size = buf.length;
  const tx = await api(`/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
    method: "PUT",
    body: JSON.stringify({
      resourceType: "planner", contentType: "image/png", fileExtension: "png",
      parts: [{ size, startByte: 0, endByte: size, hash: sha256b64 }],
    }),
  });
  if (!tx.ok || !tx.json?.data?.presignedUrl) throw new Error(`transaction failed (${tx.status})`);
  const put = await fetch(tx.json.data.presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "Content-Length": String(size), "x-amz-checksum-sha256": sha256b64 },
    body: new Uint8Array(buf),
  });
  if (!put.ok) throw new Error(`S3 PUT failed (${put.status})`);
  const done = await api(`/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
    method: "PATCH", body: JSON.stringify({ simple: { fileUrl: tx.json.data.fileUrl } }),
  });
  if (!done.ok) throw new Error(`complete failed (${done.status})`);
  return done.json?.data?.convertedFileUrl || done.json?.data?.fileUrl || tx.json.data.fileUrl;
}

/** Report how a draft came back: what the API kept, and what the provider said. */
async function inspect(id, blogId = DEFAULT_BLOG) {
  const back = await api(`/v2/scheduler/posts/${id}?${authParams(blogId)}`);
  const d = back.json?.data || {};
  return {
    mediaCount: (d.media || []).length,
    providers: d.providers || [],
    tiktokData: d.tiktokData,
    youtubeData: d.youtubeData,
    facebookData: d.facebookData,
    instagramData: d.instagramData,
  };
}

// ─── Q4: TikTok photo carousel ──────────────────────────────────────────────────

async function probeTiktokPhotos(images) {
  console.log("\n=== Q4: TIKTOK PHOTO CAROUSEL ===");
  const results = {};
  // TikTok's own API calls this PHOTO; try the plausible spellings since
  // Metricool's naming is undocumented.
  for (const contentType of ["PHOTO", "IMAGE", "CAROUSEL", "PHOTOS"]) {
    const body = {
      text: "capability probe - draft, never published",
      publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
      providers: [{ network: "tiktok" }],
      media: images,
      draft: true,
      autoPublish: false,
      tiktokData: { privacyOption: "PUBLIC_TO_EVERYONE", autoPublish: false, contentType },
    };
    const res = await createDraft(body, `tiktok-${contentType}`);
    if (!res.ok) {
      console.log(`  contentType=${contentType}: REJECTED (${res.status}) ${redact(res.text).slice(0, 160)}`);
      results[contentType] = { accepted: false, status: res.status };
      continue;
    }
    const got = await inspect(res.id);
    console.log(`  contentType=${contentType}: 200, media back=${got.mediaCount}/${images.length}, tiktokData=${redact(JSON.stringify(got.tiktokData))}`);
    results[contentType] = { accepted: true, mediaCount: got.mediaCount, echoed: got.tiktokData?.contentType };
  }
  return results;
}

// ─── Q5: YouTube with images ────────────────────────────────────────────────────

async function probeYoutubeImages(images) {
  console.log("\n=== Q5: YOUTUBE WITH IMAGES ===");
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "youtube" }],
    media: images,
    draft: true,
    autoPublish: false,
    youtubeData: { type: "short", privacy: "private", title: "Capability Probe" },
  };
  const res = await createDraft(body, "youtube-images");
  if (!res.ok) {
    console.log(`  REJECTED (${res.status}): ${redact(res.text).slice(0, 300)}`);
    return { supported: false, status: res.status, error: redact(res.text).slice(0, 300) };
  }
  const got = await inspect(res.id);
  console.log(`  create: 200, media back=${got.mediaCount}/${images.length}`);
  console.log(`  youtubeData: ${redact(JSON.stringify(got.youtubeData))}`);
  console.log(`  providers: ${redact(JSON.stringify(got.providers))}`);
  // A 200 on a draft is weak evidence: YouTube has no carousel format, so the
  // provider status is what actually matters.
  return { supported: got.mediaCount === images.length, mediaCount: got.mediaCount, providers: got.providers };
}

// ─── Q6: Facebook multi-image ───────────────────────────────────────────────────

async function probeFacebookImages(images, blogId) {
  console.log("\n=== Q6: FACEBOOK MULTI-IMAGE ===");
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "facebook" }],
    media: images,
    draft: true,
    autoPublish: false,
    facebookData: { type: "POST" },
  };
  const res = await createDraft(body, "facebook-images", blogId);
  if (!res.ok) {
    console.log(`  REJECTED (${res.status}): ${redact(res.text).slice(0, 300)}`);
    return { supported: false, status: res.status };
  }
  const got = await inspect(res.id, blogId);
  console.log(`  create: 200, media back=${got.mediaCount}/${images.length}`);
  console.log(`  facebookData: ${redact(JSON.stringify(got.facebookData))}`);
  return { supported: got.mediaCount === images.length, mediaCount: got.mediaCount };
}

// ─── Q7: per-brand network reach ────────────────────────────────────────────────

async function probeReach() {
  console.log("\n=== Q7: PER-BRAND NETWORK REACH ===");
  const res = await api(`/admin/simpleProfiles?userId=${USER_ID}`);
  const profiles = (res.json || []).filter(p => !p.deleted && !p.isDemo);
  const rows = [];
  for (const p of profiles) {
    const nets = [];
    if (p.instagram) nets.push("instagram");
    if (p.facebook) nets.push("facebook");
    if (p.tiktok) nets.push("tiktok");
    if (p.youtube) nets.push("youtube");
    if (p.linkedinCompany) nets.push("linkedin");
    rows.push({ blogId: Number(p.id), label: String(p.label), networks: nets });
    console.log(`  ${String(p.label).padEnd(32)} ${nets.join(", ")}`);
  }
  const tally = {};
  for (const r of rows) for (const n of r.networks) tally[n] = (tally[n] || 0) + 1;
  console.log(`\n  brands per network: ${JSON.stringify(tally)}`);
  return rows;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("METRICOOL CAPABILITY PROBE ROUND 3 — draft-only, publishes nothing");
  const findings = {};
  try {
    findings.reach = await probeReach();

    console.log("\n=== Uploading probe images ===");
    const images = [];
    for (const bg of [{ r: 10, g: 10, b: 12 }, { r: 20, g: 60, b: 70 }, { r: 60, g: 20, b: 60 }]) {
      const buf = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: bg } }).png().toBuffer();
      images.push(await uploadImage(buf));
    }
    console.log(`  uploaded ${images.length} images`);

    findings.tiktok = await probeTiktokPhotos(images);
    findings.youtube = await probeYoutubeImages(images);

    const fbBrand = findings.reach.find(r => r.networks.includes("facebook"));
    if (fbBrand) {
      findings.facebook = await probeFacebookImages(images, fbBrand.blogId);
    } else {
      console.log("\n=== Q6: FACEBOOK — no brand has Facebook connected, skipped ===");
    }
  } catch (err) {
    console.error(`PROBE ERROR: ${redact(err.stack || err.message)}`);
  } finally {
    await cleanup();
  }
  console.log("\n=== FINDINGS ===");
  console.log(redact(JSON.stringify(findings, null, 2)));
}

main();
