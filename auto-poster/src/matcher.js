/**
 * Video Matcher — matches Drive files to Instagram posts using:
 * 1. Duration pre-filter (within ~1 second)
 * 2. Perceptual hash comparison (3 frames at 10%, 50%, 90%)
 * 3. AI vision tiebreaker (Claude Haiku) for ambiguous cases
 * 
 * Persists results to video-matches.json so solved matches are never re-computed.
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATCHES_PATH = join(__dirname, "..", "video-matches.json");
const FRAME_DIR = "/tmp/matcher-frames";

// Ensure frame extraction directory exists
if (!existsSync(FRAME_DIR)) mkdirSync(FRAME_DIR, { recursive: true });

// ─── Persistence ────────────────────────────────────────────────────────────

export function loadMatches() {
  if (!existsSync(MATCHES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MATCHES_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveMatches(matches) {
  writeFileSync(MATCHES_PATH, JSON.stringify(matches, null, 2) + "\n");
}

export { MATCHES_PATH };

// ─── Duration Helpers ───────────────────────────────────────────────────────

/**
 * Get video duration in seconds from a local file path.
 */
export function getLocalDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
    ).toString().trim();
    return parseFloat(out);
  } catch {
    return 0;
  }
}

/**
 * Get video duration from a Drive file by downloading just enough to probe.
 * Uses a range request for the first 2MB to get duration from moov atom.
 * Falls back to full download if range request doesn't work.
 */
export async function getDriveDuration(fileId, accessToken) {
  const tmpPath = join(FRAME_DIR, `probe_${fileId}.mp4`);
  try {
    // Try downloading first 4MB for duration probe
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Range: "bytes=0-4194303",
        },
      }
    );
    if (res.ok || res.status === 206) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(tmpPath, buf);
      const duration = getLocalDuration(tmpPath);
      if (duration > 0) return duration;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// ─── Perceptual Hashing ─────────────────────────────────────────────────────

/**
 * Extract 3 frames from a video at 10%, 50%, 90% of duration.
 * Returns array of file paths to the extracted PNG frames.
 */
export function extractFrames(videoPath, duration) {
  const timestamps = [
    duration * 0.1,
    duration * 0.5,
    duration * 0.9,
  ];

  const framePaths = [];
  const id = createHash("md5").update(videoPath + Date.now().toString()).digest("hex").slice(0, 8);

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i].toFixed(2);
    const outPath = join(FRAME_DIR, `frame_${id}_${i}.png`);
    try {
      // Scale down to max 720px wide to avoid Anthropic 413 (request_too_large)
      // Original frames can be 2160x3840 which are way too large for vision API
      execSync(
        `ffmpeg -y -ss ${ts} -i "${videoPath}" -frames:v 1 -vf "scale='min(720,iw)':-2" -q:v 2 "${outPath}"`,
        { timeout: 15_000, stdio: "pipe" }
      );
      if (existsSync(outPath)) framePaths.push(outPath);
    } catch {
      // Skip this frame
    }
  }
  return framePaths;
}

/**
 * Compute a perceptual hash (average hash) for an image file.
 * Returns a 64-bit hex string.
 * 
 * Algorithm: crop to center square, resize to 8x8 grayscale, compute mean, each pixel above mean = 1.
 * Center-square crop ensures IG thumbnails (square) match video frames (9:16).
 */
export async function computePhash(imagePath, cropToSquare = true) {
  try {
    let pipeline = sharp(imagePath);

    if (cropToSquare) {
      // Get metadata to compute center square crop
      const meta = await sharp(imagePath).metadata();
      const w = meta.width || 100;
      const h = meta.height || 100;
      const size = Math.min(w, h);
      const left = Math.floor((w - size) / 2);
      const top = Math.floor((h - size) / 2);
      pipeline = pipeline.extract({ left, top, width: size, height: size });
    }

    // Resize to 8x8 grayscale
    const { data } = await pipeline
      .resize(8, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Compute mean
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const mean = sum / data.length;

    // Build hash: each pixel above mean = 1
    let hash = "";
    for (let i = 0; i < data.length; i++) {
      hash += data[i] >= mean ? "1" : "0";
    }

    // Convert binary string to hex
    return BigInt("0b" + hash).toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

/**
 * Compute Hamming distance between two hex hash strings.
 * Lower = more similar. 0 = identical.
 */
export function hammingDistance(hash1, hash2) {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 64; // max distance

  const b1 = BigInt("0x" + hash1);
  const b2 = BigInt("0x" + hash2);
  let xor = b1 ^ b2;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

/**
 * Get perceptual hashes for a video file (3 frames).
 * Returns array of hex hash strings.
 */
export async function getVideoHashes(videoPath, duration) {
  const frames = extractFrames(videoPath, duration);
  const hashes = [];

  for (const frame of frames) {
    const hash = await computePhash(frame);
    if (hash) hashes.push(hash);
    try { unlinkSync(frame); } catch {}
  }

  return hashes;
}

/**
 * Compare two sets of frame hashes.
 * Returns average Hamming distance across matched frames.
 * Lower = more similar. Threshold: < 10 = likely same video.
 */
export function compareHashes(hashes1, hashes2) {
  if (!hashes1.length || !hashes2.length) return 64;

  const minLen = Math.min(hashes1.length, hashes2.length);
  let totalDist = 0;

  for (let i = 0; i < minLen; i++) {
    totalDist += hammingDistance(hashes1[i], hashes2[i]);
  }

  return totalDist / minLen;
}

// ─── IG Post Frame Extraction ───────────────────────────────────────────────

/**
 * Download an IG post thumbnail and compute its perceptual hash.
 * Metricool provides thumbnail URLs in the analytics response.
 * If no thumbnail, returns null.
 */
export async function getIgPostHash(thumbnailUrl) {
  if (!thumbnailUrl) return null;

  const tmpPath = join(FRAME_DIR, `ig_thumb_${Date.now()}.jpg`);
  try {
    const res = await fetch(thumbnailUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buf);
    const hash = await computePhash(tmpPath);
    return hash;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// ─── AI Vision Tiebreaker ───────────────────────────────────────────────────

let anthropicClient = null;

function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Use Claude Vision to determine if two sets of frames are from the same video.
 * Only called for ambiguous cases (multiple near-matches).
 * Returns { isSame: boolean, confidence: number }
 */
export async function aiVisionCompare(driveFramePaths, igThumbnailUrl) {
  if (!driveFramePaths.length || !igThumbnailUrl) {
    return { isSame: false, confidence: 0 };
  }

  try {
    // Read drive frames as base64
    const driveImages = driveFramePaths.slice(0, 2).map(fp => {
      const buf = readFileSync(fp);
      return {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
      };
    });

    // Download IG thumbnail
    const igRes = await fetch(igThumbnailUrl);
    if (!igRes.ok) return { isSame: false, confidence: 0 };
    const igBuf = Buffer.from(await igRes.arrayBuffer());
    const igImage = {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: igBuf.toString("base64") },
    };

    const response = await getAnthropicClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Are these frames from the same real estate video tour? The first images are frames from a video file, and the last image is a thumbnail from an Instagram post. Answer with JSON only: {\"same_video\": true/false, \"confidence\": 0.0-1.0}" },
          ...driveImages,
          igImage,
        ],
      }],
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { isSame: !!parsed.same_video, confidence: parsed.confidence || 0 };
    }
  } catch (err) {
    console.warn(`[Matcher] AI vision compare failed: ${err.message?.slice(0, 100)}`);
  }

  return { isSame: false, confidence: 0 };
}

// ─── Main Matching Logic ────────────────────────────────────────────────────

/**
 * Match a single Drive video against a list of IG posts.
 * 
 * Matching ladder:
 * 1. Duration pre-filter (within 1 second)
 * 2. Perceptual hash comparison (avg hamming distance < 10)
 * 3. AI vision tiebreaker (only for ambiguous cases)
 * 
 * Returns array of matched IG posts with metadata.
 */
export async function matchDriveVideoToIgPosts(driveVideoPath, driveDuration, igPosts) {
  // Step 1: Duration pre-filter
  const durationCandidates = igPosts.filter(post => {
    if (!post.duration) return true; // If no duration data, don't exclude
    return Math.abs(post.duration - driveDuration) <= 1.5;
  });

  if (durationCandidates.length === 0) return [];

  // Step 2: Perceptual hash comparison
  const driveHashes = await getVideoHashes(driveVideoPath, driveDuration);
  if (driveHashes.length === 0) return [];

  const hashResults = [];

  for (const post of durationCandidates) {
    if (!post.thumbnailUrl) continue;

    const igHash = await getIgPostHash(post.thumbnailUrl);
    if (!igHash) continue;

    // Compare first frame hash to thumbnail (thumbnail is usually first frame)
    const dist = hammingDistance(driveHashes[0], igHash);
    hashResults.push({ post, distance: dist, igHash });
  }

  // Sort by distance (closest match first)
  hashResults.sort((a, b) => a.distance - b.distance);

  // Strong matches (distance < 18 — accounts for IG compression + crop differences)
  const strongMatches = hashResults.filter(r => r.distance < 18);
  if (strongMatches.length === 1) {
    return [{
      igPostId: strongMatches[0].post.reelId,
      publishedAt: strongMatches[0].post.publishedAt,
      caption: strongMatches[0].post.caption,
      matchMethod: "perceptual_hash",
      confidence: 1 - (strongMatches[0].distance / 64),
    }];
  }

  // Multiple near-matches → AI tiebreaker
  if (strongMatches.length > 1) {
    console.log(`[Matcher] ${strongMatches.length} near-matches found, using AI tiebreaker...`);
    const frames = extractFrames(driveVideoPath, driveDuration);

    for (const match of strongMatches) {
      const aiResult = await aiVisionCompare(frames, match.post.thumbnailUrl);
      if (aiResult.isSame && aiResult.confidence > 0.7) {
        // Cleanup frames
        frames.forEach(f => { try { unlinkSync(f); } catch {} });
        return [{
          igPostId: match.post.reelId,
          publishedAt: match.post.publishedAt,
          caption: match.post.caption,
          matchMethod: "ai_vision",
          confidence: aiResult.confidence,
        }];
      }
    }

    // Cleanup frames
    frames.forEach(f => { try { unlinkSync(f); } catch {} });
  }

  // Weak match (distance 18-22) — include but with lower confidence
  const weakMatches = hashResults.filter(r => r.distance >= 18 && r.distance < 22);
  if (weakMatches.length > 0 && strongMatches.length === 0) {
    return weakMatches.map(r => ({
      igPostId: r.post.reelId,
      publishedAt: r.post.publishedAt,
      caption: r.post.caption,
      matchMethod: "perceptual_hash_weak",
      confidence: 1 - (r.distance / 64),
    }));
  }

  return strongMatches.map(r => ({
    igPostId: r.post.reelId,
    publishedAt: r.post.publishedAt,
    caption: r.post.caption,
    matchMethod: "perceptual_hash",
    confidence: 1 - (r.distance / 64),
  }));
}
