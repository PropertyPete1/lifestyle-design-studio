#!/usr/bin/env node
/**
 * probe-capabilities.mjs — Phase 1 capability probe. READ-MOSTLY, PUBLISHES NOTHING.
 *
 * Settles three questions before any carousel feature code is written:
 *   1. Does POST /v2/scheduler/posts accept a trending-audio field for IG Reels?
 *   2. Does it accept multi-image (carousel) posts to Instagram?
 *   3. Can it publish a LinkedIn PDF document post?
 *
 * SAFETY — this script must never publish:
 *   - Every probe post is created with draft:true + autoPublish:false.
 *   - Every created draft is deleted in a finally block, and the deletions are
 *     verified with a follow-up GET.
 *   - The auth token is never printed; `redact()` scrubs it from all output.
 *
 * Method for Q1: Metricool's own help centre says audio is "web planner only".
 * Docs go stale, so we settle it three ways instead of trusting that:
 *   (a) enumerate candidate audio-library endpoints,
 *   (b) dump a real existing Reel's post object and look for an audio-shaped
 *       field (if the API models audio at all, it surfaces on read), and
 *   (c) round-trip candidate audio field names through a draft — write it, read
 *       it back, and see what survives. A field the API silently drops is a
 *       field that will silently drop at post time too.
 */

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const DEFAULT_BLOG = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !DEFAULT_BLOG) {
  console.error("Missing METRICOOL_API_TOKEN / METRICOOL_USER_ID / METRICOOL_BLOG_ID");
  process.exit(1);
}

/** Scrub the auth token out of anything we print. */
function redact(s) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return "";
  return str.split(TOKEN).join("<REDACTED>").split(USER_ID).join("<USER_ID>");
}

function authParams(blogId = DEFAULT_BLOG) {
  return `blogId=${blogId}&userId=${USER_ID}`;
}

function authHeaders() {
  return { "Content-Type": "application/json", "X-Mc-Auth": TOKEN };
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/** Draft posts we create, so the finally block can always clean them up. */
const created = [];

async function createDraft(blogId, body, label) {
  const res = await api(`/v2/scheduler/posts?${authParams(blogId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const id = res.json?.data?.id || res.json?.id;
  if (id) created.push({ id, blogId, label });
  return { ...res, id };
}

async function deleteDraft({ id, blogId, label }) {
  const res = await api(`/v2/scheduler/posts/${id}?${authParams(blogId)}`, { method: "DELETE" });
  // Verify it is actually gone rather than trusting the delete status.
  const check = await api(`/v2/scheduler/posts/${id}?${authParams(blogId)}`);
  const gone = check.status === 404 || check.status === 400 || !check.json?.data;
  console.log(`  [cleanup] ${label} id=${id}: delete=${res.status} verified_gone=${gone}`);
  return gone;
}

/** A future Chicago-local datetime string, well out so nothing is imminent. */
function futureDateTime(daysAhead = 7) {
  const d = new Date(Date.now() + daysAhead * 86400_000);
  return d.toISOString().slice(0, 19);
}

// ─── Q0: brand inventory (needed to choose a satellite for the live audio test) ──

async function probeBrands() {
  console.log("\n=== Q0: BRAND INVENTORY ===");
  const res = await api(`/admin/simpleProfiles?userId=${USER_ID}`);
  if (!res.ok) {
    console.log(`  FAILED (${res.status}): ${redact(res.text).slice(0, 200)}`);
    return [];
  }
  const brands = [];
  for (const p of res.json || []) {
    if (p.deleted === true || p.isDemo === true) continue;
    const nets = [];
    for (const n of ["instagram", "facebook", "tiktok", "youtube", "linkedin"]) {
      if (typeof p[n] === "string" && p[n]) nets.push(n);
    }
    brands.push({ blogId: Number(p.id || p.blogId), label: String(p.label || p.id), networks: nets });
  }
  for (const b of brands) {
    console.log(`  blogId=${b.blogId}  label="${b.label}"  networks=[${b.networks.join(", ")}]`);
  }
  return brands;
}

// ─── Q1: trending audio on Reels ────────────────────────────────────────────────

async function probeAudioEndpoints() {
  console.log("\n--- Q1a: candidate audio-library endpoints ---");
  const candidates = [
    "/v2/media/audios", "/v2/media/audio", "/v2/media/sounds",
    "/v2/scheduler/audios", "/v2/scheduler/audio",
    "/v2/instagram/audios", "/v2/instagram/audio", "/v2/instagram/sounds",
    "/v2/audio/search", "/v2/audios",
  ];
  const found = [];
  for (const path of candidates) {
    const res = await api(`${path}?${authParams()}`);
    const exists = res.status !== 404;
    console.log(`  ${res.status}  ${path}${exists ? "  <-- EXISTS" : ""}`);
    if (exists && res.status < 500) found.push({ path, status: res.status, sample: redact(res.text).slice(0, 300) });
  }
  return found;
}

async function probeExistingReelShape() {
  console.log("\n--- Q1b: does a real post object carry an audio field? ---");
  const from = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 19);
  const to = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 19);
  const res = await api(`/v2/scheduler/posts?${authParams()}&start=${from}&end=${to}`);
  if (!res.ok) {
    console.log(`  list failed (${res.status}): ${redact(res.text).slice(0, 200)}`);
    return null;
  }
  const posts = res.json?.data || [];
  console.log(`  found ${posts.length} posts in window`);
  const reel = posts.find(p => p.instagramData) || posts[0];
  if (!reel) return null;

  // Recursively collect every key so an audio field can't hide in a nested object.
  const keys = new Set();
  (function walk(o, prefix = "") {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      keys.add(prefix + k);
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, `${prefix}${k}.`);
    }
  })(reel);

  const audioish = [...keys].filter(k => /audio|sound|music|track/i.test(k));
  console.log(`  post object has ${keys.size} keys; audio-shaped keys: ${audioish.length ? audioish.join(", ") : "NONE"}`);
  console.log(`  instagramData keys: ${Object.keys(reel.instagramData || {}).join(", ") || "n/a"}`);
  return { keys: [...keys], audioish };
}

async function probeAudioRoundTrip(blogId, imageUrl) {
  console.log("\n--- Q1c: round-trip candidate audio fields through a draft ---");
  // Every plausible spelling, top-level and nested, in one draft. Whatever the
  // API keeps on read-back is real; everything else is silently dropped.
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "instagram" }],
    media: imageUrl ? [imageUrl] : [],
    draft: true,
    autoPublish: false,
    audio: { id: "probe-audio-id", name: "probe" },
    audioId: "probe-audio-id",
    sound: { id: "probe-sound-id" },
    soundId: "probe-sound-id",
    music: { id: "probe-music-id" },
    instagramData: {
      type: "REEL",
      showReelOnFeed: true,
      autoPublish: false,
      audioId: "probe-ig-audio-id",
      audio: { id: "probe-ig-audio", name: "probe" },
      audioName: "probe",
      soundId: "probe-ig-sound",
      musicId: "probe-ig-music",
      trendingAudio: true,
    },
  };

  const res = await createDraft(blogId, body, "audio-roundtrip");
  console.log(`  create: ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${redact(res.text).slice(0, 400)}`);
    return { accepted: false, status: res.status, error: redact(res.text).slice(0, 400) };
  }

  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams(blogId)}`);
  const data = back.json?.data || {};
  const survived = [];
  for (const k of ["audio", "audioId", "sound", "soundId", "music"]) {
    if (data[k] !== undefined) survived.push(k);
  }
  for (const k of ["audioId", "audio", "audioName", "soundId", "musicId", "trendingAudio"]) {
    if (data.instagramData?.[k] !== undefined) survived.push(`instagramData.${k}`);
  }
  console.log(`  read-back instagramData keys: ${Object.keys(data.instagramData || {}).join(", ") || "n/a"}`);
  console.log(`  audio fields that SURVIVED the round-trip: ${survived.length ? survived.join(", ") : "NONE"}`);
  return { accepted: true, survived, igKeys: Object.keys(data.instagramData || {}) };
}

// ─── Q2: Instagram photo carousel ───────────────────────────────────────────────

async function probeCarousel(blogId, imageUrls) {
  console.log("\n=== Q2: INSTAGRAM PHOTO CAROUSEL ===");
  if (imageUrls.length < 2) {
    console.log("  SKIPPED — need >=2 hosted images to probe multi-image");
    return { supported: null, reason: "no test images" };
  }
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "instagram" }],
    media: imageUrls,
    draft: true,
    autoPublish: false,
    instagramData: { type: "POST", autoPublish: false },
  };
  const res = await createDraft(blogId, body, "carousel");
  console.log(`  create with ${imageUrls.length} images: ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${redact(res.text).slice(0, 400)}`);
    return { supported: false, status: res.status, error: redact(res.text).slice(0, 400) };
  }
  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams(blogId)}`);
  const mediaBack = back.json?.data?.media || [];
  console.log(`  read-back media count: ${mediaBack.length} (sent ${imageUrls.length})`);
  console.log(`  read-back instagramData.type: ${back.json?.data?.instagramData?.type}`);
  return { supported: mediaBack.length === imageUrls.length, sent: imageUrls.length, back: mediaBack.length };
}

// ─── Q3: LinkedIn PDF document post ─────────────────────────────────────────────

async function probeLinkedinDocument(blogId, imageUrls) {
  console.log("\n=== Q3: LINKEDIN PDF DOCUMENT POST ===");
  const body = {
    text: "capability probe - draft, never published",
    publicationDate: { dateTime: futureDateTime(), timezone: "America/Chicago" },
    providers: [{ network: "linkedin" }],
    media: imageUrls,
    draft: true,
    autoPublish: false,
    linkedinData: { publishImagesAsPDF: true, documentTitle: "Capability Probe" },
  };
  const res = await createDraft(blogId, body, "linkedin-pdf");
  console.log(`  create: ${res.status}`);
  if (!res.ok) {
    console.log(`  body: ${redact(res.text).slice(0, 400)}`);
    return { supported: false, status: res.status, error: redact(res.text).slice(0, 400) };
  }
  const back = await api(`/v2/scheduler/posts/${res.id}?${authParams(blogId)}`);
  const ld = back.json?.data?.linkedinData || {};
  console.log(`  read-back linkedinData: ${redact(JSON.stringify(ld))}`);
  console.log(`  publishImagesAsPDF survived: ${ld.publishImagesAsPDF === true}`);
  console.log(`  documentTitle survived: ${JSON.stringify(ld.documentTitle)}`);
  return { supported: ld.publishImagesAsPDF === true, linkedinData: ld };
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("METRICOOL CAPABILITY PROBE — draft-only, publishes nothing");
  console.log(`started ${new Date().toISOString()}`);

  const findings = {};
  try {
    findings.brands = await probeBrands();

    // Reuse images already in the media library — no uploads, no new assets.
    const imgRes = await api(`/v2/media/images?${authParams()}`);
    const imgs = (imgRes.json?.data || []).map(i => i.url || i.fileUrl || i.convertedFileUrl).filter(Boolean);
    console.log(`\n  media library: ${imgs.length} images available for probing`);
    const testImages = imgs.slice(0, 3);

    console.log("\n=== Q1: TRENDING AUDIO ON REELS ===");
    findings.audioEndpoints = await probeAudioEndpoints();
    findings.reelShape = await probeExistingReelShape();
    findings.audioRoundTrip = await probeAudioRoundTrip(DEFAULT_BLOG, testImages[0]);

    findings.carousel = await probeCarousel(DEFAULT_BLOG, testImages);
    findings.linkedin = await probeLinkedinDocument(DEFAULT_BLOG, testImages.slice(0, 2));
  } catch (err) {
    console.error(`PROBE ERROR: ${redact(err.message)}`);
  } finally {
    console.log(`\n=== CLEANUP: deleting ${created.length} probe drafts ===`);
    for (const d of created) {
      try { await deleteDraft(d); } catch (e) { console.error(`  cleanup failed for ${d.id}: ${redact(e.message)}`); }
    }
  }

  console.log("\n=== MACHINE-READABLE FINDINGS ===");
  console.log(redact(JSON.stringify(findings, null, 2)));
}

main();
