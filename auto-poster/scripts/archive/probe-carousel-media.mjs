#!/usr/bin/env node
/**
 * probe-capabilities-2.mjs — Phase 1 probe, round 2. PUBLISHES NOTHING.
 *
 * Round 1 left three gaps:
 *   - Q2 (carousel) was skipped: the media library had 0 images to probe with.
 *     This round generates its own PNGs and uploads them.
 *   - Q3 (LinkedIn PDF) passed the schema round-trip but with an EMPTY media
 *     array, so it only proved the flags persist, not that a real document
 *     post assembles. Re-probed here with actual images attached.
 *   - Round 1's brand inventory showed no LinkedIn on any profile, while
 *     linkedin.js posts to three blogIds — one of which (4807109) did not
 *     appear at all. Dumps the raw profile shape to settle how LinkedIn
 *     connections are represented.
 *
 * Same safety contract as round 1: draft:true + autoPublish:false on every
 * post, all drafts deleted and verified gone, token never printed.
 */

import sharp from "sharp";
import { createHash } from "crypto";
import { requireLiveAck } from "../live-guard.mjs";

// TOUCHES LIVE: uploads generated PNGs into the real Metricool MEDIA LIBRARY and
// creates draft posts referencing them. Drafts are deleted and verified gone;
// the uploaded media is not always removable — an orphaned library file is
// exactly what the multipart probe left behind once.
requireLiveAck(
  "Uploads images to the live Metricool media library and creates draft posts. " +
    "Uploaded media may not be deletable and can be left orphaned in the library."
);

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

async function createDraft(blogId, body, label) {
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

/** Upload a PNG buffer through the same S3 transaction flow metricool.js uses for video. */
async function uploadImage(buf, blogId = DEFAULT_BLOG) {
  const sha256b64 = createHash("sha256").update(buf).digest("base64");
  const size = buf.length;

  const tx = await api(`/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
    method: "PUT",
    body: JSON.stringify({
      resourceType: "planner",
      contentType: "image/png",
      fileExtension: "png",
      parts: [{ size, startByte: 0, endByte: size, hash: sha256b64 }],
    }),
  });
  if (!tx.ok || !tx.json?.data?.presignedUrl) {
    throw new Error(`transaction failed (${tx.status}): ${redact(tx.text).slice(0, 200)}`);
  }

  const put = await fetch(tx.json.data.presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(size),
      "x-amz-checksum-sha256": sha256b64,
    },
    body: new Uint8Array(buf),
  });
  if (!put.ok) throw new Error(`S3 PUT failed (${put.status})`);

  const done = await api(`/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
    method: "PATCH",
    body: JSON.stringify({ simple: { fileUrl: tx.json.data.fileUrl } }),
  });
  if (!done.ok) throw new Error(`complete failed (${done.status}): ${redact(done.text).slice(0, 200)}`);

  return done.json?.data?.convertedFileUrl || done.json?.data?.fileUrl || tx.json.data.fileUrl;
}

/** A 1080x1350 solid-colour PNG — same dimensions the real carousel will render at. */
async function makeSlide(color, label) {
  return sharp({
    create: { width: 1080, height: 1350, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

// ─── Q0b: how are LinkedIn connections represented on a profile? ─────────────────

async function probeProfileShape() {
  console.log("\n=== Q0b: RAW PROFILE SHAPE (LinkedIn connectivity) ===");
  const res = await api(`/admin/simpleProfiles?userId=${USER_ID}`);
  if (!res.ok) {
    console.log(`  FAILED (${res.status})`);
    return null;
  }
  const profiles = (res.json || []).filter(p => !p.deleted && !p.isDemo);
  // Show every key whose name or value mentions a network, so a LinkedIn
  // connection can't hide behind an unexpected key name.
  const first = profiles[0] || {};
  const netKeys = Object.keys(first).filter(k => /linkedin|instagram|facebook|tiktok|youtube|twitter|threads|pinterest|bluesky/i.test(k));
  console.log(`  network-ish keys on a profile: ${netKeys.join(", ")}`);

  for (const p of profiles) {
    const li = {};
    for (const k of Object.keys(p)) {
      if (/linkedin/i.test(k)) li[k] = p[k];
    }
    console.log(`  blogId=${redact(String(p.id))} label="${p.label}" linkedin fields: ${JSON.stringify(li)}`);
  }

  // linkedin.js targets these three explicitly — confirm they exist and are ours.
  console.log("\n  --- blogIds hardcoded in linkedin.js ---");
  for (const id of [4807109, 6493212, 6486275]) {
    const found = profiles.find(p => Number(p.id) === id);
    console.log(`  ${id}: ${found ? `PRESENT ("${found.label}")` : "NOT IN PROFILE LIST"}`);
  }
  return profiles.map(p => ({ id: p.id, label: p.label, keys: Object.keys(p) }));
}

// ─── Q2: Instagram photo carousel, with real uploaded images ────────────────────

async function probeCarousel(images) {
  console.log("\n=== Q2: INSTAGRAM PHOTO CAROUSEL (real media) ===");
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "instagram" }],
    media: images,
    draft: true,
    autoPublish: false,
    instagramData: { type: "POST", autoPublish: false },
  };
  const res = await createDraft(DEFAULT_BLOG, body, "carousel-3img");
  console.log(`  create with ${images.length} images: ${res.status}`);
  if (!res.ok) {
    console.log(`  error: ${redact(res.text).slice(0, 400)}`);
    return { supported: false, status: res.status, error: redact(res.text).slice(0, 400) };
  }
  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams()}`);
  const mediaBack = back.json?.data?.media || [];
  console.log(`  read-back media count: ${mediaBack.length} (sent ${images.length})`);
  console.log(`  read-back instagramData: ${redact(JSON.stringify(back.json?.data?.instagramData || {}))}`);

  // Metricool validates posts before publishing; surface any validation verdict.
  const d = back.json?.data || {};
  for (const k of ["status", "detailedStatus", "errors", "validationErrors", "providers"]) {
    if (d[k] !== undefined) console.log(`  ${k}: ${redact(JSON.stringify(d[k])).slice(0, 300)}`);
  }
  return { supported: mediaBack.length === images.length, sent: images.length, back: mediaBack.length };
}

// ─── Q3: LinkedIn PDF document post, with real uploaded images ──────────────────

async function probeLinkedinDoc(images) {
  console.log("\n=== Q3: LINKEDIN PDF DOCUMENT POST (real media) ===");
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "linkedin" }],
    media: images,
    draft: true,
    autoPublish: false,
    linkedinData: { publishImagesAsPDF: true, documentTitle: "Capability Probe Document" },
  };
  const res = await createDraft(DEFAULT_BLOG, body, "linkedin-pdf-3img");
  console.log(`  create with ${images.length} images: ${res.status}`);
  if (!res.ok) {
    console.log(`  error: ${redact(res.text).slice(0, 400)}`);
    return { supported: false, status: res.status, error: redact(res.text).slice(0, 400) };
  }
  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams()}`);
  const d = back.json?.data || {};
  console.log(`  read-back linkedinData: ${redact(JSON.stringify(d.linkedinData || {}))}`);
  console.log(`  read-back media count: ${(d.media || []).length} (sent ${images.length})`);
  for (const k of ["status", "detailedStatus", "errors", "validationErrors"]) {
    if (d[k] !== undefined) console.log(`  ${k}: ${redact(JSON.stringify(d[k])).slice(0, 300)}`);
  }
  return {
    supported: d.linkedinData?.publishImagesAsPDF === true && (d.media || []).length === images.length,
    linkedinData: d.linkedinData,
  };
}

// ─── Q1d: does audioName alone survive onto a REEL with real media? ─────────────

async function probeAudioNameOnReel(videoOrImage) {
  console.log("\n=== Q1d: audioName on a REEL (round 1's lone survivor) ===");
  // Round 1 found instagramData.audioName was the only audio field that
  // persisted. Check whether it is a real selector or just a free-text label:
  // a selector would validate against Meta's library and reject nonsense.
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "instagram" }],
    media: [videoOrImage],
    draft: true,
    autoPublish: false,
    instagramData: {
      type: "REEL",
      showReelOnFeed: true,
      autoPublish: false,
      audioName: "zzz-not-a-real-song-" + Date.now(),
    },
  };
  const res = await createDraft(DEFAULT_BLOG, body, "audioname-reel");
  console.log(`  create with nonsense audioName: ${res.status}`);
  if (!res.ok) {
    console.log(`  error: ${redact(res.text).slice(0, 300)}`);
    return { accepted: false };
  }
  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams()}`);
  const ig = back.json?.data?.instagramData || {};
  console.log(`  read-back instagramData: ${redact(JSON.stringify(ig))}`);
  console.log(`  VERDICT: nonsense audioName was ${ig.audioName ? "ACCEPTED (free-text label, not a library selector)" : "rejected"}`);
  return { accepted: true, audioName: ig.audioName };
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("METRICOOL CAPABILITY PROBE ROUND 2 — draft-only, publishes nothing");
  const findings = {};
  try {
    findings.profiles = await probeProfileShape();

    console.log("\n=== Uploading probe images ===");
    const colors = [
      { r: 10, g: 10, b: 12 },
      { r: 20, g: 60, b: 70 },
      { r: 60, g: 20, b: 60 },
    ];
    const images = [];
    for (let i = 0; i < colors.length; i++) {
      const buf = await makeSlide(colors[i], `slide-${i + 1}`);
      const url = await uploadImage(buf);
      images.push(url);
      console.log(`  uploaded slide ${i + 1}: ${(buf.length / 1024).toFixed(0)} KB -> ${url.slice(0, 70)}...`);
    }

    findings.carousel = await probeCarousel(images);
    findings.linkedin = await probeLinkedinDoc(images);
    findings.audioName = await probeAudioNameOnReel(images[0]);
  } catch (err) {
    console.error(`PROBE ERROR: ${redact(err.stack || err.message)}`);
  } finally {
    await cleanup();
  }
  console.log("\n=== FINDINGS ===");
  console.log(redact(JSON.stringify(findings, null, 2)));
}

main();
