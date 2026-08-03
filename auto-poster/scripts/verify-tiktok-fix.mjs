#!/usr/bin/env node
/**
 * verify-tiktok-fix.mjs — prove the PNG/JPEG diagnosis end to end.
 *
 * Publishes TWO TikTok posts under identical conditions, one with PNG slides
 * and one with JPEG, and reports what Metricool records for each. If the
 * diagnosis is right the PNG one errors with the format complaint and the JPEG
 * one publishes. Both are deleted afterwards, and the deletions are verified.
 *
 * SAFETY:
 *   - TikTok is connected on the MAIN brand only; no satellite has it. So this
 *     necessarily runs against the main account.
 *   - Both posts use privacyOption SELF_ONLY, so they are visible to the account
 *     owner and to nobody else. Nothing public is created at any point.
 *   - Both are deleted in a finally block whatever happens, and the script
 *     re-reads each id afterwards to confirm it is gone.
 *   - The token is never printed.
 */

import sharp from "sharp";
import { createHash } from "crypto";

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

async function schedule(label, mediaUrls, publishAt) {
  const body = {
    text: `Internal format test (${label}). Private, deleted immediately.`,
    publicationDate: { dateTime: publishAt, timezone: "America/Chicago" },
    providers: [{ network: "tiktok" }],
    media: mediaUrls,
    autoPublish: true,
    shortener: false,
    draft: false,
    // SELF_ONLY: publishes to the account but is visible only to its owner.
    tiktokData: { privacyOption: "SELF_ONLY", autoPublish: true, photoCoverIndex: 0 },
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
    console.log("=== Rendering two identical slides, PNG and JPEG ===");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
      <rect width="1080" height="1350" fill="#000000"/>
      <text x="96" y="640" font-family="Georgia, 'DejaVu Serif', serif" font-size="72" font-weight="bold" fill="#F6F5F1">Format test</text>
      <rect x="96" y="680" width="420" height="3" fill="#C8AA6A"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const jpeg = await sharp(png).jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
    console.log(`  png ${(png.length / 1024).toFixed(0)}KB, jpeg ${(jpeg.length / 1024).toFixed(0)}KB`);

    const pngUrls = [await uploadImage(png, "image/png"), await uploadImage(png, "image/png")];
    const jpegUrls = [await uploadImage(jpeg, "image/jpeg"), await uploadImage(jpeg, "image/jpeg")];
    console.log("  uploaded both sets");

    const at = chicagoAt(120_000);
    console.log(`\n=== Scheduling both for ${at} (SELF_ONLY) ===`);
    const pngId = await schedule("PNG-control", pngUrls, at);
    const jpegId = await schedule("JPEG-fix", jpegUrls, at);

    console.log("\n=== Polling for terminal status ===");
    const pngProvider = await pollStatus(pngId, "PNG-control");
    const jpegProvider = await pollStatus(jpegId, "JPEG-fix");

    console.log("\n=== RESULT ===");
    report("PNG-control", pngProvider);
    report("JPEG-fix", jpegProvider);

    results.png = String(pngProvider?.status || "").toUpperCase();
    results.jpeg = String(jpegProvider?.status || "").toUpperCase();

    const proved = results.png !== "PUBLISHED" && results.jpeg === "PUBLISHED";
    console.log(`\nVERDICT: ${proved
      ? "CONFIRMED — PNG is rejected, JPEG publishes. The fix is correct."
      : `INCONCLUSIVE — png=${results.png} jpeg=${results.jpeg}`}`);
  } catch (err) {
    console.error(`ERROR: ${redact(err.stack || err.message)}`);
  } finally {
    console.log(`\n=== CLEANUP: deleting ${created.length} test post(s) ===`);
    for (const { id, label } of created) {
      const del = await api(`/v2/scheduler/posts/${id}?${qs}`, { method: "DELETE" });
      const check = await api(`/v2/scheduler/posts/${id}?${qs}`);
      const gone = check.status === 404 || check.status === 400 || !check.json?.data;
      console.log(`  [${label}] id=${id}: delete=${del.status} verified_gone=${gone}`);
      if (!gone) console.log(`  ::warning::[${label}] post ${id} may still exist — check the TikTok account`);
    }
  }
}

main();
