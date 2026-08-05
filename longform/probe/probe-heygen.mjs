#!/usr/bin/env node
/**
 * probe-heygen.mjs — Phase 0, question 1. Confirms we can programmatically
 * generate avatar segments with Peter's avatar, and measures what a minute costs.
 *
 * Four things have to be true before we build on HeyGen:
 *   1. the key authenticates and has a balance,
 *   2. Peter's avatar id resolves to a real look we are allowed to render,
 *   3. a scripted segment renders end to end and comes back as a downloadable
 *      16:9 mp4 at the resolution we asked for,
 *   4. the avatar can lip-sync to OUR audio (audio_url), not only to a HeyGen
 *      voice — that is what keeps one ElevenLabs voice across the avatar
 *      segments and the B-roll narration instead of two different voices.
 *
 * COST. Generation costs real money, so it is opt-in: the render steps only run
 * with HEYGEN_PROBE_GENERATE=1. Balance is read before and after, so the run
 * reports the ACTUAL charge for a known number of seconds rather than a rate
 * quoted from a docs page. At the published Avatar III Digital Twin rate
 * ($0.0167/sec) the default 12-second probe costs about $0.20.
 *
 * The engine matters more than anything else here: avatar_iv is the API DEFAULT
 * and costs 4x avatar_iii for a Digital Twin. This probe renders on the engine
 * we intend to use in production and prices it.
 */

const BASE = "https://api.heygen.com";
const KEY = process.env.HEYGEN_API_KEY;
const AVATAR_ID = process.env.HEYGEN_AVATAR_ID;
const DO_GENERATE = process.env.HEYGEN_PROBE_GENERATE === "1";
const ENGINE = process.env.HEYGEN_ENGINE || "avatar_iii";
const RESOLUTION = process.env.HEYGEN_RESOLUTION || "1080p";
/** Public URL of an ElevenLabs-rendered clip, to prove the lip-sync path. */
const LIPSYNC_AUDIO_URL = process.env.HEYGEN_PROBE_AUDIO_URL || "";

if (!KEY) {
  console.log("HEYGEN_API_KEY is not set — Phase 0 question 1 is BLOCKED.");
  console.log("Add HEYGEN_API_KEY (and HEYGEN_AVATAR_ID) as repo secrets, then re-run.");
  process.exit(78); // EX_CONFIG: blocked on config, not a failure of the probe
}

function redact(s) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return "";
  return str.split(KEY).join("<REDACTED>");
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "x-api-key": KEY, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/** The docs move between versions; ask several shapes and report which answers. */
async function probeAuthAndBalance() {
  console.log("\n=== 1: AUTH + BALANCE ===");
  const candidates = ["/v3/users/me", "/v2/user/remaining_quota", "/v1/user/remaining_quota"];
  let balance = null;
  for (const path of candidates) {
    const res = await api(path);
    console.log(`  ${res.status}  ${path}`);
    if (res.ok) {
      console.log(`    ${redact(res.text).slice(0, 400)}`);
      const d = res.json?.data || res.json || {};
      const found = d.remaining_credits ?? d.remaining_quota ?? d.credit_balance ?? d.balance ?? d.credits;
      if (found != null && balance == null) balance = Number(found);
    }
  }
  console.log(`  parsed balance: ${balance == null ? "could not parse — see raw above" : balance}`);
  return balance;
}

async function probeAvatar() {
  console.log("\n=== 2: DOES PETER'S AVATAR RESOLVE? ===");
  if (!AVATAR_ID) {
    console.log("  HEYGEN_AVATAR_ID not set — listing available avatars instead.");
  }

  const list = await api("/v3/avatars?limit=100");
  console.log(`  GET /v3/avatars -> ${list.status}`);
  if (list.ok) {
    const items = list.json?.data?.avatars || list.json?.data?.items || list.json?.data || [];
    const arr = Array.isArray(items) ? items : [];
    console.log(`  ${arr.length} avatar(s) on this account:`);
    for (const a of arr.slice(0, 25)) {
      const id = a.avatar_id || a.id || a.look_id;
      console.log(`    ${id}  "${a.avatar_name || a.name || ""}"  type=${a.type || a.avatar_type || "?"}`);
    }
  } else {
    console.log(`    ${redact(list.text).slice(0, 300)}`);
  }

  if (!AVATAR_ID) return null;

  // The look endpoint reports which engines this avatar may render on — the
  // single fact that decides the per-minute price.
  const look = await api(`/v3/avatars/looks/${encodeURIComponent(AVATAR_ID)}`);
  console.log(`  GET /v3/avatars/looks/${AVATAR_ID} -> ${look.status}`);
  if (look.ok) {
    console.log(`    ${redact(look.text).slice(0, 600)}`);
    const d = look.json?.data || {};
    const engines = d.supported_engines || d.engines || d.engine_support;
    console.log(`  supported engines: ${engines ? JSON.stringify(engines) : "not reported — see raw above"}`);
  } else {
    console.log(`    ${redact(look.text).slice(0, 300)}`);
  }
  return look.ok ? look.json?.data : null;
}

async function probeVoices() {
  console.log("\n=== 3: VOICE OPTIONS (only needed if we do NOT lip-sync our own audio) ===");
  const res = await api("/v3/voices?limit=5");
  console.log(`  GET /v3/voices -> ${res.status}`);
  if (res.ok) {
    const items = res.json?.data?.voices || res.json?.data?.items || res.json?.data || [];
    const arr = Array.isArray(items) ? items : [];
    console.log(`  ${arr.length} voice(s) returned (truncated list)`);
    for (const v of arr.slice(0, 5)) {
      console.log(`    ${v.voice_id || v.id}  "${v.name || ""}"  ${v.language || ""}`);
    }
  }
}

async function generate(body, label) {
  console.log(`\n  --- generating: ${label} ---`);
  console.log(`  request: ${JSON.stringify(body)}`);
  const res = await api("/v3/videos", {
    method: "POST",
    headers: { "Idempotency-Key": `probe-${label}-${Date.now()}` },
    body: JSON.stringify(body),
  });
  console.log(`  POST /v3/videos -> ${res.status}`);
  if (!res.ok) {
    console.log(`    ${redact(res.text).slice(0, 600)}`);
    return { ok: false, status: res.status, error: redact(res.text).slice(0, 600) };
  }
  const videoId = res.json?.data?.video_id;
  console.log(`  video_id=${videoId} status=${res.json?.data?.status}`);

  const startedAt = Date.now();
  const TIMEOUT_MS = 15 * 60_000;
  let last = null;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 10_000));
    const poll = await api(`/v3/videos/${videoId}`);
    const d = poll.json?.data || {};
    last = d;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`    [${elapsed}s] status=${d.status || poll.status}`);
    if (d.status === "completed") {
      console.log(`  RENDERED in ${elapsed}s`);
      console.log(`  video_url present: ${Boolean(d.video_url)}`);
      console.log(`  duration: ${d.duration ?? "not reported"}`);
      return { ok: true, videoId, data: d, renderSeconds: Number(elapsed) };
    }
    if (d.status === "failed") {
      console.log(`  FAILED: ${redact(d.failure_message || d.error || JSON.stringify(d)).slice(0, 400)}`);
      return { ok: false, videoId, data: d };
    }
  }
  console.log("  TIMED OUT after 15 min");
  return { ok: false, videoId, data: last, timedOut: true };
}

async function probeGeneration() {
  console.log("\n=== 4: RENDER A REAL SEGMENT ===");
  if (!DO_GENERATE) {
    console.log("  SKIPPED — set HEYGEN_PROBE_GENERATE=1 to spend real credits on a ~12s render.");
    return null;
  }
  if (!AVATAR_ID) {
    console.log("  SKIPPED — HEYGEN_AVATAR_ID not set.");
    return null;
  }

  const script =
    "If you are moving to San Antonio, the number everyone gets wrong is not the price. " +
    "It is the monthly payment, and here is why that gap matters.";

  const base = {
    type: "avatar",
    avatar_id: AVATAR_ID,
    resolution: RESOLUTION,
    aspect_ratio: "16:9",
    output_format: "mp4",
    engine: { type: ENGINE },
    title: "Phase 0 probe segment",
  };

  const results = {};

  // 4a. Script + HeyGen voice — the baseline path.
  results.scripted = await generate({ ...base, script }, "scripted");

  // 4b. Lip-sync to our own ElevenLabs audio — the path that keeps ONE voice
  // across the whole video. This is the capability worth proving.
  if (LIPSYNC_AUDIO_URL) {
    results.lipsync = await generate({ ...base, audio_url: LIPSYNC_AUDIO_URL }, "lipsync-elevenlabs");
  } else {
    console.log("\n  --- lip-sync path: SKIPPED (set HEYGEN_PROBE_AUDIO_URL to a public ElevenLabs mp3) ---");
    console.log("  This is the one that decides whether Peter has one voice or two.");
  }

  return results;
}

async function main() {
  console.log("PHASE 0 PROBE — HeyGen avatar generation");
  console.log(`  engine=${ENGINE}  resolution=${RESOLUTION}  generate=${DO_GENERATE}\n`);

  const before = await probeAuthAndBalance();
  await probeAvatar();
  await probeVoices();
  const gen = await probeGeneration();

  if (DO_GENERATE) {
    console.log("\n=== 5: WHAT IT ACTUALLY COST ===");
    const after = await probeAuthAndBalance();
    if (before != null && after != null) {
      console.log(`  balance before=${before} after=${after} delta=${(before - after).toFixed(4)}`);
      const secs = gen?.scripted?.data?.duration;
      if (secs) console.log(`  per-second observed: ${((before - after) / Number(secs)).toFixed(5)} for ${secs}s`);
    } else {
      console.log("  balance not parseable — read the raw payloads above for the charge.");
    }
  }

  console.log("\n=== PUBLISHED RATES (developers.heygen.com/docs/pricing) ===");
  console.log("  Avatar III Digital Twin  $0.0167/sec = $1.00/min");
  console.log("  Avatar IV  Digital Twin  $0.0667/sec = $4.00/min   <-- API DEFAULT");
  console.log("  Avatar V   Digital Twin  $0.0667/sec = $4.00/min");
  console.log("  A 12-min video at 30% avatar screen time = ~3.6 min of avatar:");
  console.log("    on Avatar III ~ $3.60/video  -> ~$15.60/month weekly");
  console.log("    on Avatar IV  ~ $14.40/video -> ~$62.40/month weekly");
}

main().catch(err => {
  console.error(`\nPROBE ERROR: ${redact(err?.stack || String(err))}`);
  process.exitCode = 1;
});
