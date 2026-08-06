/**
 * yt-upload.js — putting a 320MB long-form render into Metricool's media library.
 *
 * The existing src/metricool.js uploader sends ONE part and compresses anything
 * over 95MB to fit. That is right for a 30-second Reel and wrong for a
 * 12-minute video: squeezing 320MB into 95MB is about 1 Mbps, and it looks
 * like it. Metricool's 100MB limit turned out to be per PART, not per file, so
 * long-form goes up as a real S3 multipart upload instead.
 *
 * EVERY NUMBER AND SHAPE HERE WAS ESTABLISHED BY A LIVE ROUND-TRIP
 * (longform/probe/probe-multipart-upload.mjs, 2026-08-05: 21MB in 3 parts,
 * fetched back byte-identical). None of it is inferred from documentation,
 * because the documentation does not cover any of it.
 *
 *   part size floor    5 MiB   — S3's own multipart minimum, every part but the
 *                                last. Undersized parts UPLOAD FINE and return
 *                                etags; the minimum is only enforced at
 *                                completion, so getting this wrong wastes the
 *                                whole transfer before failing.
 *   part size ceiling  100 MB  — Metricool rejects the transaction outright,
 *                                before any bytes move. The cheap failure.
 *   per-part hash      base64 sha256 of that part's bytes, sent both in the
 *                      transaction and as x-amz-checksum-sha256 on the PUT.
 *   completion         PATCH { multipart: { key, uploadId, parts: [
 *                        { partNumber, etag } ] } }
 *                      `key` is required and lowercase field names matter — the
 *                      capitalised S3-style variant is rejected field by field.
 *
 * KNOWN GAP, and it is not ours to fix: there is no API to DELETE planner
 * media. Every candidate endpoint returns 404, 405, or "Request method 'DELETE'
 * is not supported". A weekly long-form upload therefore grows the media
 * library without bound, and clearing it is a manual job in the Metricool
 * planner. Worth raising with them.
 */

import { createHash } from "crypto";

const BASE = "https://app.metricool.com/api";

/** S3 requires every part but the last to be at least this big. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

/** Metricool rejects any part over this. */
export const MAX_PART_BYTES = 100 * 1024 * 1024;

/**
 * Target part size. Comfortably inside both bounds, and big enough that a
 * 320MB render is ~7 parts rather than 40 — every part is a round trip, and
 * each one is a chance to fail on a flaky runner.
 */
export const TARGET_PART_BYTES = 50 * 1024 * 1024;

/** Single-part upload is simpler and is what the Reels path already does. */
export const SINGLE_PART_LIMIT = MAX_PART_BYTES;

function authParams(blogId, userId) {
  return `blogId=${blogId}&userId=${userId}`;
}

function authHeaders(token) {
  return { "Content-Type": "application/json", "X-Mc-Auth": token };
}

/**
 * Split a file into parts that satisfy both bounds.
 *
 * Pure, and the only part of this worth unit-testing hard: an off-by-one here
 * either drops bytes or produces an undersized part that fails only after the
 * whole file has been transferred.
 */
export function planParts(totalBytes, { targetPartBytes = TARGET_PART_BYTES } = {}) {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
    throw new Error(`planParts needs a positive byte count, got ${totalBytes}`);
  }
  if (totalBytes <= SINGLE_PART_LIMIT) {
    return [{ partNumber: 1, start: 0, end: totalBytes, size: totalBytes }];
  }

  const target = Math.min(Math.max(targetPartBytes, MIN_PART_BYTES), MAX_PART_BYTES);
  let count = Math.ceil(totalBytes / target);
  let size = Math.ceil(totalBytes / count);

  // Rounding up the size can push it over the ceiling; add a part and retry.
  while (size > MAX_PART_BYTES) {
    count += 1;
    size = Math.ceil(totalBytes / count);
  }

  // The final part is whatever is left, and it is the only one allowed to be
  // under 5 MiB. If the split leaves a runt final part, use fewer, bigger parts
  // so the remainder grows — which is safe because size is still under the
  // ceiling by construction.
  while (count > 1) {
    const lastSize = totalBytes - size * (count - 1);
    if (lastSize >= MIN_PART_BYTES || lastSize === totalBytes) break;
    const nextCount = count - 1;
    const nextSize = Math.ceil(totalBytes / nextCount);
    if (nextSize > MAX_PART_BYTES) break;
    count = nextCount;
    size = nextSize;
  }

  const parts = [];
  for (let i = 0; i < count; i++) {
    const start = i * size;
    const end = Math.min(start + size, totalBytes);
    if (start >= totalBytes) break;
    parts.push({ partNumber: parts.length + 1, start, end, size: end - start });
  }

  // Never hand back a plan that would fail at completion.
  const undersized = parts.slice(0, -1).filter((p) => p.size < MIN_PART_BYTES);
  if (undersized.length > 0) {
    throw new Error(
      `cannot split ${totalBytes} bytes into parts of at least ${MIN_PART_BYTES} — ` +
      `part ${undersized[0].partNumber} would be ${undersized[0].size}`
    );
  }
  const covered = parts.reduce((n, p) => n + p.size, 0);
  if (covered !== totalBytes) {
    throw new Error(`part plan covers ${covered} of ${totalBytes} bytes`);
  }
  return parts;
}

export const sha256b64 = (buf) => createHash("sha256").update(buf).digest("base64");

/**
 * The completion body Metricool accepts for a multipart upload.
 *
 * Kept as its own function because it was expensive to discover and because
 * getting it wrong fails only after the entire file has been transferred.
 */
export function completionBody({ key, uploadId, parts }) {
  return {
    multipart: {
      key,
      uploadId,
      parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    },
  };
}

/** The single-part completion body, matching what the Reels path already sends. */
export function simpleCompletionBody(fileUrl) {
  return { simple: { fileUrl } };
}

async function api(path, token, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(token), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Upload a video buffer, choosing single-part or multipart by size.
 *
 * Returns the hosted CDN URL. Throws with the failing stage named — an upload
 * that half-worked is worse than one that clearly did not, because the caller
 * would otherwise schedule a post against a URL serving a truncated file.
 *
 * @param {Buffer} buffer
 * @param {object} opts  { blogId, userId, token, onProgress }
 */
export async function uploadVideo(buffer, { blogId, userId, token, onProgress = () => {} } = {}) {
  if (!blogId || !userId || !token) throw new Error("uploadVideo needs blogId, userId and token");
  const total = buffer.length;
  const parts = planParts(total);
  const multipart = parts.length > 1;

  console.log(
    `[YTUpload] ${(total / 1024 / 1024).toFixed(1)} MB as ${parts.length} part(s) ` +
    `(${multipart ? "multipart" : "single"})`
  );

  const withHashes = parts.map((p) => {
    const bytes = buffer.subarray(p.start, p.end);
    return { ...p, bytes, hash: sha256b64(bytes) };
  });

  // 1. open the transaction
  const txRes = await api(`/v2/media/s3/upload-transactions?${authParams(blogId, userId)}`, token, {
    method: "PUT",
    body: JSON.stringify({
      resourceType: "planner",
      contentType: "video/mp4",
      fileExtension: "mp4",
      parts: withHashes.map((p) => ({ size: p.size, startByte: p.start, endByte: p.end, hash: p.hash })),
    }),
  });
  if (!txRes.ok) {
    throw new Error(`upload transaction refused (${txRes.status}): ${txRes.text.slice(0, 300)}`);
  }
  const tx = txRes.json?.data || {};
  const urls = normaliseUrls(tx);
  if (urls.length !== parts.length) {
    throw new Error(`expected ${parts.length} presigned URL(s), got ${urls.length}`);
  }

  // 2. upload every part
  const uploaded = [];
  for (let i = 0; i < withHashes.length; i++) {
    const p = withHashes[i];
    const res = await fetch(urls[i], {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(p.size),
        "x-amz-checksum-sha256": p.hash,
      },
      body: new Uint8Array(p.bytes),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`part ${p.partNumber}/${parts.length} rejected (${res.status}): ${err.slice(0, 200)}`);
    }
    uploaded.push({ partNumber: p.partNumber, etag: (res.headers.get("etag") || "").replace(/"/g, "") });
    onProgress({ part: p.partNumber, of: parts.length, bytes: p.size });
    console.log(`[YTUpload] part ${p.partNumber}/${parts.length} ok`);
  }

  // 3. complete
  const body = multipart
    ? completionBody({ key: tx.key, uploadId: tx.uploadId, parts: uploaded })
    : simpleCompletionBody(tx.fileUrl);
  const doneRes = await api(`/v2/media/s3/upload-transactions?${authParams(blogId, userId)}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!doneRes.ok) {
    throw new Error(`upload completion failed (${doneRes.status}): ${doneRes.text.slice(0, 300)}`);
  }

  const data = doneRes.json?.data || {};
  const hostedUrl = data.convertedFileUrl || data.fileUrl;
  if (!hostedUrl) throw new Error("completion returned no hosted URL");
  console.log(`[YTUpload] complete — ${parts.length} part(s) stitched`);
  return hostedUrl;
}

/** The transaction returns per-part URLs under one of a few shapes. */
function normaliseUrls(tx) {
  const raw = tx.parts || tx.presignedUrls || (tx.presignedUrl ? [tx.presignedUrl] : []);
  return (Array.isArray(raw) ? raw : [])
    .map((u) => (typeof u === "string" ? u : u?.presignedUrl || u?.url))
    .filter(Boolean);
}
