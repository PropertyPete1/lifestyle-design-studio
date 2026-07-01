/**
 * Serverless-friendly per-repost video differentiation (NO ffmpeg).
 *
 * WHY: Instagram/TikTok/YouTube fingerprint the exact bytes of an uploaded
 * video. When the SAME .mp4 is fanned out to 3 Instagram accounts + TikTok +
 * YouTube + LinkedIn at once (or re-posted within a short window), platforms can
 * detect the byte-identical file as duplicate content and floor its reach. A
 * manual re-download/re-share often produced a slightly different file, which is
 * part of why manual reposts historically out-performed the byte-identical
 * automated uploads.
 *
 * WHAT (the fix): produce a per-destination variant whose bytes differ from the
 * source while the decoded video and audio are IDENTICAL to the human eye/ear.
 * We do this with a spec-legal MP4 trick rather than a re-encode:
 *
 *   - Append a top-level `free` box (a.k.a. skip/padding box, ISO/IEC 14496-12)
 *     to the end of the file, filled with random bytes. Every conforming player
 *     ignores `free` boxes entirely, so playback is unchanged. But the file's
 *     SHA-256 / perceptual-adjacent exact-hash changes on every call.
 *   - Optionally we can insert multiple random-sized `free` boxes so even the
 *     file length differs run to run.
 *
 * This runs in pure Node (Buffer only) — no ffmpeg, no native binaries — so it
 * works on the Autoscale (Cloud Run) Node-only production runtime where the old
 * ffmpeg approach silently no-oped.
 *
 * If anything fails (download, upload) the caller falls back to the original
 * URL rather than blocking the post — differentiation is an enhancement, not a
 * hard requirement for publishing.
 */

import crypto from "node:crypto";
import { storageGetSignedUrl, storagePut } from "./storage";

export interface VariantResult {
  ok: boolean;
  /** Public URL of the differentiated video (when ok). */
  url?: string;
  /** SHA-256 (hex) of the produced bytes, for logging/verification. */
  sha256?: string;
  error?: string;
}

/**
 * Build a top-level MP4 `free` box containing `payloadLen` random bytes.
 * Box layout (big-endian): [uint32 size][4-char type "free"][payload...].
 * `size` includes the 8-byte header.
 */
function makeFreeBox(payloadLen: number): Buffer {
  const size = 8 + payloadLen;
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write("free", 4, "ascii");
  crypto.randomFillSync(box, 8, payloadLen);
  return box;
}

/**
 * Given the source MP4 bytes, return a byte-different but visually/audibly
 * identical variant by appending random `free` padding box(es) at the end.
 *
 * Appending trailing `free` boxes is the safest edit: it never touches the
 * `moov`/`mdat` offsets, so no atom rewriting is required and playback is
 * guaranteed unchanged. We add 1–2 boxes of random size so both the content
 * hash AND the total length vary between runs.
 */
export function differentiateMp4Bytes(source: Buffer): Buffer {
  const boxes: Buffer[] = [source];
  const boxCount = 1 + (crypto.randomInt(0, 2)); // 1 or 2 boxes
  for (let i = 0; i < boxCount; i++) {
    // 16–96 random bytes of payload per box.
    const payloadLen = 16 + crypto.randomInt(0, 81);
    boxes.push(makeFreeBox(payloadLen));
  }
  return Buffer.concat(boxes);
}

async function downloadBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error("downloaded file too small");
  return buf;
}

export interface MakeVariantOptions {
  /** Public URL of the source .mp4 */
  sourceUrl: string;
  /** Instagram postId, used only to name the output key. */
  postId: string;
  /**
   * Optional per-destination salt (e.g. brand label or platform). Included in
   * the storage key so each destination gets its own distinct file; the random
   * `free` boxes already guarantee different bytes regardless.
   */
  salt?: string;
  /** Pre-fetched source bytes (avoid re-downloading across destinations). */
  sourceBytes?: Buffer;
}

/**
 * Produce a serverless byte-differentiated variant of the source video and
 * upload it. Returns the public URL of the new file, or an error (caller falls
 * back to the original URL).
 */
export async function makeDifferentiatedVariant(
  opts: MakeVariantOptions
): Promise<VariantResult> {
  const { sourceUrl, postId, salt } = opts;
  try {
    const source = opts.sourceBytes ?? (await downloadBytes(sourceUrl));
    const variant = differentiateMp4Bytes(source);
    const sha256 = crypto.createHash("sha256").update(variant).digest("hex");

    const stamp = Date.now();
    const rand = crypto.randomUUID().slice(0, 8);
    const saltPart = salt ? `${salt.replace(/[^a-z0-9]+/gi, "-").slice(0, 24)}_` : "";
    const { key } = await storagePut(
      `reel-variants/${postId}_${saltPart}${stamp}_${rand}.mp4`,
      variant,
      "video/mp4"
    );
    // Metricool must fetch the media from a public absolute URL. The signed S3
    // GET URL is directly reachable (the /manus-storage proxy is relative to the
    // app and not guaranteed to be resolvable by Metricool's fetchers).
    const url = await storageGetSignedUrl(key);
    return { ok: true, url, sha256 };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.message };
  }
}
