#!/usr/bin/env node
/**
 * probe-multipart-upload.mjs — the one real multipart round-trip.
 *
 * A 12-minute 1080p render is ~320MB and Metricool's ceiling is 100MB PER PART.
 * An earlier probe proved a multipart transaction is ACCEPTED and issues one
 * presigned URL per part. It proved nothing about whether the parts can be
 * uploaded, ordered, and stitched back into a usable file — and by this repo's
 * own standard, "accepted" is not "works".
 *
 * So this moves real bytes. It deliberately does NOT use a small single-part
 * upload: that would succeed for reasons that say nothing about the 320MB case.
 * It splits a ~12MB file into 3 parts and proves each mechanic separately:
 *
 *   - a distinct presigned URL per part, each with its own checksum
 *   - parts uploaded and accepted individually
 *   - completion stitching them into ONE convertedFileUrl
 *   - the fetched file byte-identical to what went up (this is the real test —
 *     wrong part ORDER would still produce a plausible-looking file of exactly
 *     the right size, and only a byte compare catches that)
 *
 * SAFETY, and why this cannot post anything:
 *   - The upload transaction body names no social account. Nowhere in the flow
 *     is a network, provider or connected profile identified. Publishing needs
 *     a separate POST /v2/scheduler/posts naming providers[].
 *   - The preflight probe found NO auto-publishing queue on this brand: every
 *     autolist / evergreen / recycle / rss endpoint returns 404.
 *   - The scheduler post count is captured before and after and compared. If
 *     anything appeared, this fails loudly rather than reporting success.
 *   - The test file is a solid-colour slate reading "TEST FILE - DELETE ME".
 *     Even in the impossible case, nothing brand-shaped reaches an account.
 *
 * AND, the TikTok lesson: a delete that returns 200 is a claim, not a fact.
 * The 2026-08-03 TikTok failure went unnoticed because the log said ok:true and
 * held nothing to check that claim against. So the deletion is verified by
 * re-fetching the URL and requiring it to stop serving the bytes.
 */

import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { requireLiveAck } from "../../auto-poster/scripts/live-guard.mjs";

// TOUCHES LIVE: uploads ~12MB of real bytes into the Metricool MEDIA LIBRARY.
// It names no social account and creates no post, so it cannot publish — but on
// its first run no delete endpoint would accept the file and it was left
// orphaned in the library. probe-media-delete.mjs exists because of that.
requireLiveAck(
  "Uploads ~12MB into the live Metricool media library. Publishes nothing, but cleanup is not " +
    "guaranteed — the first run left an orphaned file that needed probe-media-delete.mjs to remove."
);
const TOKEN = process.env.METRICOOL_API_TOKEN;
const USER_ID = process.env.METRICOOL_USER_ID;
const BLOG_ID = process.env.METRICOOL_BLOG_ID;

if (!TOKEN || !USER_ID || !BLOG_ID) {
  console.error("Missing METRICOOL_API_TOKEN / METRICOOL_USER_ID / METRICOOL_BLOG_ID");
  process.exit(1);
}

/** Three parts, so ordering is actually exercised. Two could pass by luck. */
const PART_COUNT = 3;

/**
 * S3's multipart rule: EVERY PART EXCEPT THE LAST MUST BE AT LEAST 5 MiB.
 *
 * Found the hard way. A 12MB file in three parts is 3.84MB each, all three
 * parts uploaded fine and returned etags, and completion then failed with
 * "Your proposed upload is smaller than the minimum allowed size" from S3
 * itself. The parts being individually accepted says nothing — the minimum is
 * only enforced when the upload is completed.
 *
 * So a valid part size is bounded on BOTH sides:
 *   >= 5 MiB   (S3, except the final part)
 *   <= 100 MB  (Metricool's own ceiling)
 *
 * 21MB in three parts gives 7MB each: comfortably inside both bounds, and
 * still a throwaway.
 */
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 100 * 1024 * 1024;
const TARGET_MB = 21;

function redact(s) {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  if (!str) return "";
  return str.split(TOKEN).join("<REDACTED>").split(USER_ID).join("<USER_ID>").split(BLOG_ID).join("<BLOG_ID>");
}

const authParams = () => `blogId=${BLOG_ID}&userId=${USER_ID}`;
const authHeaders = () => ({ "Content-Type": "application/json", "X-Mc-Auth": TOKEN });

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text, headers: res.headers };
}

const sha256b64 = (buf) => createHash("sha256").update(buf).digest("base64");
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * A file nobody would mistake for content, at a size that needs real multipart.
 *
 * `-fs` is what makes the size predictable: it stops the encode once the output
 * reaches the limit, producing a valid, playable mp4 at a known size. The first
 * attempt at this used a quality target instead and produced 628MB from twenty
 * seconds of noise — parts of 209MB each, which Metricool refused outright.
 *
 * testsrc2 changes every frame, which guarantees the three parts differ from
 * each other so a mis-ordered stitch cannot accidentally byte-match the
 * original.
 */
function buildTestFile(dir) {
  const path = join(dir, "multipart-probe-DELETE-ME.mp4");
  execFileSync("ffmpeg", [
    "-y",
    // testsrc2 is cheap to generate and its content changes every frame, which
    // is what makes the three parts differ. An earlier version used a noise
    // filter for that and was too CPU-heavy to finish in reasonable time.
    "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=120",
    "-vf",
    "drawtext=text='TEST FILE - DELETE ME':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2",
    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "5000k", "-pix_fmt", "yuv420p",
    // Hard stop at the target size — the encode ends here, whatever the duration.
    "-fs", `${TARGET_MB}M`,
    path,
  ], { stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });

  const size = statSync(path).size;
  const mb = size / 1024 / 1024;
  if (mb > TARGET_MB * 1.5) {
    throw new Error(`test file came out ${mb.toFixed(1)}MB, expected about ${TARGET_MB}MB — refusing to upload it`);
  }
  return path;
}

async function schedulerPostIds() {
  const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19);
  const to = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 19);
  const res = await api(`/v2/scheduler/posts?${authParams()}&start=${from}&end=${to}`);
  if (!res.ok) return null;
  return new Set((res.json?.data || []).map((p) => String(p.id)));
}

/**
 * Complete the multipart upload.
 *
 * The shape was established by letting the validator name what it wanted. The
 * first attempt sent uploadId + parts and got back
 * `{"multipart.key":"Key is required"}` — the S3 object key from the
 * transaction is required alongside the parts, and partNumber/etag are
 * lowercase (the capitalised variant was rejected field by field).
 */
async function completeTransaction(tx, uploadedParts) {
  const parts = uploadedParts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
  const candidates = [
    {
      label: "multipart: key + uploadId + parts",
      body: { multipart: { key: tx.key, uploadId: tx.uploadId, parts } },
    },
    {
      label: "multipart: key + uploadId + parts + fileUrl",
      body: { multipart: { key: tx.key, uploadId: tx.uploadId, fileUrl: tx.fileUrl, parts } },
    },
    {
      label: "multipart: key + uploadId + bucket + parts",
      body: { multipart: { key: tx.key, uploadId: tx.uploadId, bucket: tx.bucket, parts } },
    },
  ];

  for (const c of candidates) {
    const res = await api(`/v2/media/s3/upload-transactions?${authParams()}`, {
      method: "PATCH",
      body: JSON.stringify(c.body),
    });
    console.log(`  complete via "${c.label}": ${res.status}`);
    if (res.ok) {
      console.log(`    ${redact(res.text).slice(0, 400)}`);
      return { ok: true, shape: c.label, body: c.body, data: res.json?.data || res.json };
    }
    console.log(`    ${redact(res.text).slice(0, 300)}`);
  }
  return { ok: false };
}

/** Delete, then PROVE it. A 200 from a delete endpoint is a claim, not a fact. */
async function deleteAndVerify(hostedUrl, mediaId) {
  console.log("\n=== 6: DELETE, AND VERIFY THE DELETE ===");
  const candidates = [
    mediaId ? `/v2/media/${mediaId}?${authParams()}` : null,
    mediaId ? `/v2/media/files/${mediaId}?${authParams()}` : null,
    `/v2/media?${authParams()}&url=${encodeURIComponent(hostedUrl)}`,
  ].filter(Boolean);

  let deleteAccepted = false;
  for (const path of candidates) {
    const res = await api(path, { method: "DELETE" });
    console.log(`  DELETE ${path.split("?")[0]} -> ${res.status}`);
    if (res.ok) { deleteAccepted = true; break; }
  }

  // The verification that matters, whatever the delete returned.
  const check = await fetch(hostedUrl).catch(() => null);
  const stillServing = Boolean(check && check.ok);
  console.log(`  re-fetch of the hosted URL: ${check ? check.status : "network error"}`);
  console.log(`  still serving bytes: ${stillServing}`);

  if (!deleteAccepted) {
    console.log("  ::warning:: no delete endpoint accepted the request");
  }
  if (stillServing) {
    console.log("  ::warning:: THE FILE IS STILL SERVING. Remove it by hand in the Metricool planner.");
    console.log(`  ::warning:: url: ${hostedUrl}`);
  }
  return { deleteAccepted, stillServing };
}

async function main() {
  console.log("MULTIPART ROUND-TRIP — moves real bytes into the media library, then removes them.");
  console.log("Uploads a throwaway slate. Creates NO post. Names NO social account.\n");

  const dir = join(tmpdir(), `mp-probe-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  let hostedUrl = null;

  try {
    // ── 0. baseline ────────────────────────────────────────────────────────
    console.log("=== 0: SCHEDULER BASELINE ===");
    const before = await schedulerPostIds();
    console.log(`  ${before ? before.size : "?"} posts before`);

    // ── 1. the file ────────────────────────────────────────────────────────
    console.log("\n=== 1: BUILD THE TEST FILE ===");
    const filePath = buildTestFile(dir);
    const buf = readFileSync(filePath);
    const total = buf.length;
    console.log(`  ${(total / 1024 / 1024).toFixed(2)} MB, sha256 ${sha256hex(buf).slice(0, 16)}...`);
    // Three parts of a 12MB file are 4MB each: comfortably multipart, and far
    // enough under the 100MB per-part ceiling that the ceiling is not what is
    // being tested here.
    if (total < 6 * 1024 * 1024) {
      throw new Error(`test file is only ${(total / 1024 / 1024).toFixed(1)}MB — too small to exercise multipart meaningfully`);
    }
    // Both bounds are checked before a single byte moves, because a part that
    // is out of range uploads happily and only fails at completion — by which
    // point an orphaned multipart upload is already sitting in S3.
    const partBytes = Math.ceil(total / PART_COUNT);
    if (partBytes > MAX_PART_BYTES) {
      throw new Error(`parts would be ${(partBytes / 1024 / 1024).toFixed(1)}MB, over Metricool's 100MB ceiling — aborting before any upload`);
    }
    if (PART_COUNT > 1 && partBytes < MIN_PART_BYTES) {
      throw new Error(
        `parts would be ${(partBytes / 1024 / 1024).toFixed(2)}MB, under S3's 5 MiB multipart minimum — ` +
        `completion would fail after the bytes had already moved. Aborting before any upload.`
      );
    }
    console.log(`  part size ${(partBytes / 1024 / 1024).toFixed(2)} MB (S3 min 5 MiB, Metricool max 100 MB) — OK`);

    // ── 2. the transaction ─────────────────────────────────────────────────
    console.log(`\n=== 2: OPEN A ${PART_COUNT}-PART TRANSACTION ===`);
    const chunk = Math.ceil(total / PART_COUNT);
    const parts = [];
    for (let i = 0; i < PART_COUNT; i++) {
      const start = i * chunk;
      const end = Math.min(start + chunk, total);
      const slice = buf.subarray(start, end);
      parts.push({ partNumber: i + 1, startByte: start, endByte: end, size: slice.length, bytes: slice, hash: sha256b64(slice) });
    }
    parts.forEach((p) => console.log(`  part ${p.partNumber}: bytes ${p.startByte}-${p.endByte} (${(p.size / 1024 / 1024).toFixed(2)} MB)`));

    const txRes = await api(`/v2/media/s3/upload-transactions?${authParams()}`, {
      method: "PUT",
      body: JSON.stringify({
        resourceType: "planner",
        contentType: "video/mp4",
        fileExtension: "mp4",
        parts: parts.map((p) => ({ size: p.size, startByte: p.startByte, endByte: p.endByte, hash: p.hash })),
      }),
    });
    console.log(`  PUT transaction -> ${txRes.status}`);
    if (!txRes.ok) throw new Error(`transaction refused: ${redact(txRes.text).slice(0, 300)}`);

    const tx = txRes.json?.data || {};
    console.log(`  response keys: ${Object.keys(tx).join(", ")}`);
    console.log(`  key=${redact(String(tx.key)).slice(0, 80)}`);
    console.log(`  uploadId present: ${Boolean(tx.uploadId)}  bucket present: ${Boolean(tx.bucket)}  fileUrl present: ${Boolean(tx.fileUrl)}`);
    const urls = tx.parts || tx.presignedUrls || (tx.presignedUrl ? [tx.presignedUrl] : []);
    const urlList = (Array.isArray(urls) ? urls : []).map((u) => (typeof u === "string" ? u : u?.presignedUrl || u?.url));
    console.log(`  ${urlList.length} presigned URL(s) issued for ${PART_COUNT} part(s)`);
    if (urlList.length !== PART_COUNT) {
      throw new Error(`expected ${PART_COUNT} presigned URLs, got ${urlList.length} — this is not real multipart`);
    }
    const distinct = new Set(urlList).size;
    console.log(`  distinct URLs: ${distinct}${distinct === PART_COUNT ? " (each part has its own)" : " <-- NOT PER-PART"}`);

    // ── 3. upload each part ────────────────────────────────────────────────
    console.log("\n=== 3: UPLOAD EACH PART ===");
    const uploaded = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const res = await fetch(urlList[i], {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(p.size),
          "x-amz-checksum-sha256": p.hash,
        },
        body: new Uint8Array(p.bytes),
      });
      const etag = res.headers.get("etag");
      console.log(`  part ${p.partNumber}: ${res.status}  etag=${etag || "(none)"}`);
      if (!res.ok) throw new Error(`part ${p.partNumber} rejected (${res.status}): ${(await res.text()).slice(0, 200)}`);
      uploaded.push({ partNumber: p.partNumber, etag: (etag || "").replace(/"/g, "") });
    }

    // ── 4. complete ────────────────────────────────────────────────────────
    console.log("\n=== 4: COMPLETE THE TRANSACTION ===");
    const completed = await completeTransaction(tx, uploaded);
    if (!completed.ok) throw new Error("no completion shape was accepted — multipart cannot be finished");
    hostedUrl = completed.data?.convertedFileUrl || completed.data?.fileUrl || tx.fileUrl;
    const mediaId = completed.data?.id || completed.data?.mediaId || null;
    console.log(`  completion shape that worked: "${completed.shape}"`);
    console.log(`  hosted URL: ${redact(String(hostedUrl)).slice(0, 100)}`);

    // ── 5. the real test: byte-compare ─────────────────────────────────────
    console.log("\n=== 5: FETCH IT BACK AND BYTE-COMPARE ===");
    // Conversion can lag; give it a few tries before calling it a failure.
    let fetched = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const res = await fetch(hostedUrl).catch(() => null);
      if (res && res.ok) {
        fetched = Buffer.from(await res.arrayBuffer());
        break;
      }
      console.log(`  attempt ${attempt}: ${res ? res.status : "network error"} — waiting 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!fetched) throw new Error("the hosted URL never served the file");

    console.log(`  downloaded ${(fetched.length / 1024 / 1024).toFixed(2)} MB (uploaded ${(total / 1024 / 1024).toFixed(2)} MB)`);
    const sizeMatch = fetched.length === total;
    const hashMatch = sha256hex(fetched) === sha256hex(buf);
    console.log(`  size identical:  ${sizeMatch}`);
    console.log(`  sha256 identical: ${hashMatch}`);
    if (!hashMatch) {
      // Size can match while order is wrong — that is exactly what this catches.
      console.log(`  uploaded sha256: ${sha256hex(buf)}`);
      console.log(`  fetched  sha256: ${sha256hex(fetched)}`);
      console.log(sizeMatch
        ? "  >>> SAME SIZE, DIFFERENT BYTES — the parts were stitched in the wrong order."
        : "  >>> The file came back a different size.");
    } else {
      console.log("  >>> MULTIPART ROUND-TRIP VERIFIED: 3 parts, stitched in order, byte-identical.");
    }

    // ── 6. clean up, and prove it ──────────────────────────────────────────
    const cleanup = await deleteAndVerify(hostedUrl, mediaId);

    // ── 7. prove nothing was posted ────────────────────────────────────────
    console.log("\n=== 7: DID ANYTHING GET POSTED? ===");
    const after = await schedulerPostIds();
    if (before && after) {
      const added = [...after].filter((id) => !before.has(id));
      console.log(`  posts before: ${before.size}, after: ${after.size}, new: ${added.length}`);
      if (added.length > 0) {
        console.log(`  ::error:: NEW POSTS APPEARED: ${added.join(", ")} — investigate immediately`);
        process.exitCode = 1;
      } else {
        console.log("  >>> No post was created. A media upload is inert, as expected.");
      }
    }

    console.log("\n=== VERDICT ===");
    console.log(`  multipart accepted:      yes (${PART_COUNT} per-part presigned URLs)`);
    console.log(`  parts uploaded:          yes`);
    console.log(`  completion shape:        "${completed.shape}"`);
    console.log(`  byte-identical:          ${hashMatch}`);
    console.log(`  removed afterwards:      ${!cleanup.stillServing}`);
    if (!hashMatch) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nPROBE FAILED: ${redact(err?.stack || String(err))}`);
  process.exitCode = 1;
});
