#!/usr/bin/env node
/**
 * verify-tiktok-fix.mjs — prove the PNG/JPEG diagnosis end to end.
 *
 * Round 2. Round 1 proved PNG errors and JPEG clears the format gate, but ran
 * SELF_ONLY, and the JPEG post stopped at AWAITING_CONFIRMATION. That state is
 * not photo-specific (a video hit it once in 111), so the open question is
 * whether SELF_ONLY caused it. This repeats the JPEG post with the production
 * privacy setting, PUBLIC_TO_EVERYONE, to remove that variable.
 *
 * The post is deleted as soon as it reaches a terminal status.
 *
 * SAFETY:
 *   - TikTok is connected on the MAIN brand only; no satellite has it. So this
 *     necessarily runs against the main account.
 *   - This round publishes PUBLIC_TO_EVERYONE because that is the setting the
 *     daily job uses and the one whose behaviour is in question. The post is
 *     visible for the couple of minutes between publishing and deletion.
 *   - The token is never printed.
 *
 * KNOWN LIMITATION, learned the hard way on 2026-08-03: deleting the Metricool
 * scheduler entry does NOT retract a post the network has already published.
 * The cleanup below removes the scheduler record and reports verified_gone, but
 * a TikTok post that reached PUBLISHED stays live on the account and has to be
 * deleted in the TikTok app by hand. Anyone re-running this must expect to do
 * that, or keep privacyOption on SELF_ONLY and accept a slower signal.
 */

import sharp from "sharp";
import { createHash } from "crypto";
import { requireLiveAck } from "../live-guard.mjs";

// TOUCHES LIVE: publishes a real post to the MAIN TikTok account with
// privacyOption PUBLIC_TO_EVERYONE — it is visible to followers for the minutes
// between publishing and cleanup. Deleting the Metricool scheduler entry does
// NOT retract it; a post that reached PUBLISHED must be removed by hand in the
// TikTok app. TikTok is connected on the main brand only, so there is no
// satellite account to test against instead.
requireLiveAck(
  "Publishes a PUBLIC post to the MAIN TikTok account. Cleanup CANNOT retract it — " +
    "you will have to delete the post by hand in the TikTok app."
);

const BASE = "https://app.metricool.com/api";
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !BLOG_ID) {
  console.error("Missing Metricool credentials");
  process.exit(1);
}

const redact = (s) => String(s ?? "").split(TOKEN).join("<TOKEN>").split(USER_ID).join("<USER>").split(String(BLOG_ID)).join("<BLOG>");
const headers = () => ({ "Content-Type": "application/json", "X-Mc-Auth": TOKEN });
const qs = `blogId=${BLOG_ID}&userId=${USER_ID}`;

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: headers(), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function uploadImage(buf, contentType) {
  const hash = createHash("sha256").update(buf).digest("base64");
  const size = buf.length;
  const tx = await api(`/v2/media/s3/upload-transactions?${qs}`, {
    method: "PUT",
    body: JSON.stringify({
      resourceType: "planner",
      contentType,
      fileExtension: contentType === "image/jpeg" ? "jpg" : "png",
      parts: [{ size, startByte: 0, endByte: size, hash }],
    }),
  });
  if (!tx.ok || !tx.json?.data?.presignedUrl) throw new Error(`transaction failed ${tx.status}`);
  const put = await fetch(tx.json.data.presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(size), "x-amz-checksum-sha256": hash },
    body: new Uint8Array(buf),
  });
  if (!put.ok) throw new Error(`S3 PUT failed ${put.status}`);
  const done = await api(`/v2/media/s3/upload-transactions?${qs}`, {
    method: "PATCH", body: JSON.stringify({ simple: { fileUrl: tx.json.data.fileUrl } }),
  });
  if (!done.ok) throw new Error(`complete failed ${done.status}`);
  return done.json?.data?.convertedFileUrl || done.json?.data?.fileUrl || tx.json.data.fileUrl;
}

/** Chicago-local datetime, `offsetMs` from now. */
function chicagoAt(offsetMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(Date.now() + offsetMs));
  const g = (t) => parts.find((p) => p.type === t).value;
  const h = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")}T${h}:${g("minute")}:${g("second")}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const created = [];
/** ids that reached PUBLISHED — deleting the scheduler entry will not retract these. */
const published = new Map();

async function schedule(label, mediaUrls, publishAt) {
  const body = {
    text: `Internal format test (${label}). Private, deleted immediately.`,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "tiktok" }],
    media: mediaUrls,
    autoPublish: true,
    shortener: false,
    draft: false,
    // Production setting — the one whose behaviour we need to observe.
    tiktokData: { privacyOption: "PUBLIC_TO_EVERYONE", autoPublish: true, photoCoverIndex: 0 },
  };
  const res = await api(`/v2/scheduler/posts?${qs}`, { method: "POST", body: JSON.stringify(body) });
  const id = res.json?.data?.id || res.json?.id;
  if (id) created.push({ id, label });
  console.log(`  [${label}] scheduled: HTTP ${res.status}, id=${id}`);
  if (!res.ok) console.log(`  [${label}] body: ${redact(res.text).slice(0, 300)}`);
  return id;
}

async function pollStatus(id, label, maxMs = 360_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < maxMs) {
    const res = await api(`/v2/scheduler/posts/${id}?${qs}`);
    const providers = res.json?.data?.providers || [];
    const p = providers[0];
    last = p;
    const status = String(p?.status || "?").toUpperCase();
    if (["PUBLISHED", "ERROR", "FAILED", "REJECTED"].includes(status)) {
      console.log(`  [${label}] TERMINAL after ${Math.round((Date.now() - started) / 1000)}s`);
      if (status === "PUBLISHED") published.set(id, p.publicUrl || "(no url reported)");
      return p;
    }
    console.log(`  [${label}] ${status}... (${Math.round((Date.now() - started) / 1000)}s)`);
    await sleep(20_000);
  }
  console.log(`  [${label}] still not terminal after ${Math.round(maxMs / 1000)}s`);
  return last;
}

function report(label, provider) {
  if (!provider) return console.log(`  [${label}] no provider data`);
  console.log(`  [${label}] status=${provider.status}`);
  console.log(`  [${label}] detail=${JSON.stringify(provider.detailedStatus)}`);
  if (provider.publicUrl) console.log(`  [${label}] url=${provider.publicUrl}`);
}

async function main() {
  const results = {};
  try {
    console.log("=== Rendering JPEG slides ===");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
      <rect width="1080" height="1350" fill="#000000"/>
      <text x="96" y="640" font-family="Georgia, 'DejaVu Serif', serif" font-size="72" font-weight="bold" fill="#F6F5F1">Format test</text>
      <rect x="96" y="680" width="420" height="3" fill="#C8AA6A"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const jpeg = await sharp(png).jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
    console.log(`  jpeg ${(jpeg.length / 1024).toFixed(0)}KB`);

    const jpegUrls = [await uploadImage(jpeg, "image/jpeg"), await uploadImage(jpeg, "image/jpeg")];
    console.log("  uploaded JPEG set");

    const at = chicagoAt(120_000);
    console.log(`\n=== Scheduling JPEG photo post for ${at} (PUBLIC_TO_EVERYONE) ===`);
    const jpegId = await schedule("JPEG-public", jpegUrls, at);

    console.log("\n=== Polling for terminal status ===");
    const jpegProvider = await pollStatus(jpegId, "JPEG-public", 480_000);

    console.log("\n=== RESULT ===");
    report("JPEG-public", jpegProvider);
    results.jpeg = String(jpegProvider?.status || "").toUpperCase();

    console.log(`\nVERDICT: ${
      results.jpeg === "PUBLISHED"
        ? "TikTok photo carousels DO publish with JPEG. Keep the photo path."
        : results.jpeg === "AWAITING_CONFIRMATION"
          ? "JPEG clears the format gate but still needs in-app confirmation, so photo posts cannot publish unattended. Switch TikTok to the slide video."
          : `UNEXPECTED — ${results.jpeg}`}`);
  } catch (err) {
    console.error(`ERROR: ${redact(err.stack || err.message)}`);
  } finally {
    console.log(`\n=== CLEANUP: deleting ${created.length} test post(s) ===`);
    for (const { id, label } of created) {
      const del = await api(`/v2/scheduler/posts/${id}?${qs}`, { method: "DELETE" });
      const check = await api(`/v2/scheduler/posts/${id}?${qs}`);
      const gone = check.status === 404 || check.status === 400 || !check.json?.data;
      console.log(`  [${label}] scheduler entry id=${id}: delete=${del.status} verified_gone=${gone}`);
      if (!gone) console.log(`  ::warning::[${label}] scheduler entry ${id} may still exist`);
      if (published.has(id)) {
        console.log(`  ::warning::[${label}] post ${id} had already PUBLISHED — the live post is NOT removed by this delete and must be deleted in the TikTok app: ${published.get(id)}`);
      }
    }
  }
}

main();
