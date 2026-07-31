/**
 * Pre-Post Quality Check — verify video is suitable before uploading to 4 accounts.
 *
 * 1. Programmatic checks: aspect ratio (vertical 9:16), duration (5s-3min), file size
 * 2. AI vision check: send 2 frames to Claude Haiku for content verification
 *
 * NOTE ON COMPRESSION: this module does NOT compress. Compression happens in
 * exactly one place — metricool.js, which fits the video under its 95MB upload
 * cap using a high-quality two-pass encode. QC previously ran its own CRF 28 /
 * ultrafast pass on anything over 200MB, which was both redundant (any file that
 * large goes through the Metricool compressor anyway) and quality-destroying
 * (a throwaway low-quality generation ahead of the real encode).
 *
 * The size check here is now a sanity cap only: a file over 500MB is almost
 * certainly the wrong file or a corrupt download, so it fails loudly rather than
 * being silently re-encoded.
 */
import { execSync } from "child_process";
import { statSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";

let anthropicClient = null;
function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Run all quality checks on a video file.
 * @param {string} videoPath - Path to the processed video (post-voiceover)
 * @returns {{ ok: boolean, reason: string, details: object }}
 */
export async function prePostQualityCheck(videoPath) {
  console.log("[QC] Running pre-post quality check...");
  const details = {};

  // ─── Programmatic Checks ───────────────────────────────────────────────────
  try {
    // Get video metadata via ffprobe
    const probeJson = execSync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${videoPath}"`,
      { encoding: "utf-8", timeout: 30000 }
    );
    const probe = JSON.parse(probeJson);
    const videoStream = probe.streams?.find(s => s.codec_type === "video");

    if (!videoStream) {
      return { ok: false, reason: "No video stream found — file may be corrupted", details };
    }

    // Aspect ratio check: must be vertical (height > width, roughly 9:16)
    const width = parseInt(videoStream.width);
    const height = parseInt(videoStream.height);
    details.resolution = `${width}x${height}`;
    const aspectRatio = width / height;

    if (aspectRatio > 0.75) {
      // Not vertical enough (wider than 3:4)
      return { ok: false, reason: `Not vertical: ${width}x${height} (ratio ${aspectRatio.toFixed(2)}, need < 0.75)`, details };
    }

    // Duration check: 5s to 3min (180s)
    const duration = parseFloat(probe.format?.duration || videoStream.duration || "0");
    details.duration = `${duration.toFixed(1)}s`;

    if (duration < 5) {
      return { ok: false, reason: `Too short: ${duration.toFixed(1)}s (minimum 5s)`, details };
    }
    if (duration > 180) {
      return { ok: false, reason: `Too long: ${duration.toFixed(1)}s (maximum 180s)`, details };
    }

    // File size check: must be > 100KB (not empty/corrupt) and under the 500MB
    // sanity cap. Anything between is passed through untouched — metricool.js
    // compresses it to fit its 95MB upload cap as the single compression point.
    const fileSize = statSync(videoPath).size;
    details.fileSize = `${(fileSize / 1024 / 1024).toFixed(1)}MB`;

    if (fileSize < 100 * 1024) {
      return { ok: false, reason: `File too small: ${(fileSize / 1024).toFixed(0)}KB — likely corrupted`, details };
    }
    if (fileSize > 500 * 1024 * 1024) {
      // Sanity cap: at this size it's almost certainly the wrong file or a
      // corrupt download. Fail loudly rather than feeding it to the compressor.
      return { ok: false, reason: `File too large: ${(fileSize / 1024 / 1024).toFixed(0)}MB — exceeds 500MB sanity cap (likely corrupt or wrong file)`, details };
    }
    if (fileSize > 95 * 1024 * 1024) {
      console.log(`[QC] File is ${(fileSize / 1024 / 1024).toFixed(0)}MB — over Metricool's 95MB cap; metricool.js will compress it on upload.`);
    }

    console.log(`[QC] Programmatic: ${width}x${height}, ${duration.toFixed(1)}s, ${(fileSize / 1024 / 1024).toFixed(1)}MB — PASS`);
  } catch (err) {
    return { ok: false, reason: `ffprobe failed: ${err.message?.slice(0, 100)}`, details };
  }

  // ─── AI Vision Check ───────────────────────────────────────────────────────
  try {
    const frames = extractQCFrames(videoPath);
    if (frames.length === 0) {
      return { ok: false, reason: "Could not extract frames for vision check", details };
    }

    const visionResult = await checkFramesWithVision(frames);
    details.visionResult = visionResult;

    // Clean up frames
    frames.forEach(f => { try { unlinkSync(f); } catch {} });

    if (!visionResult.ok) {
      return { ok: false, reason: `AI vision: ${visionResult.reason}`, details };
    }

    console.log(`[QC] AI vision: OK — "${visionResult.reason}"`);
  } catch (err) {
    // AI vision failure is non-fatal — log but allow
    console.warn(`[QC] AI vision check failed (non-fatal): ${err.message?.slice(0, 100)}`);
    details.visionError = err.message;
  }

  console.log("[QC] All checks PASSED ✓");
  return { ok: true, reason: "All checks passed", details };
}

/**
 * Extract 2 frames from the video for vision analysis.
 */
function extractQCFrames(videoPath) {
  const id = createHash("md5").update(videoPath + Date.now().toString()).digest("hex").slice(0, 8);
  const framePaths = [];

  // Get duration
  let duration = 30;
  try {
    const result = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: "utf-8", timeout: 15000 }
    ).trim();
    duration = parseFloat(result) || 30;
  } catch {}

  // Extract frames at 25% and 60% (avoid intro/outro)
  const timestamps = [duration * 0.25, duration * 0.6];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i].toFixed(2);
    const outPath = join(tmpdir(), `qc_frame_${id}_${i}.jpg`);
    try {
      execSync(
        `ffmpeg -y -ss ${ts} -i "${videoPath}" -frames:v 1 -q:v 3 "${outPath}"`,
        { timeout: 15000, stdio: "pipe" }
      );
      if (existsSync(outPath)) framePaths.push(outPath);
    } catch {}
  }

  return framePaths;
}

/**
 * Send frames to Claude Haiku for content verification.
 */
async function checkFramesWithVision(framePaths) {
  const imageContent = framePaths.map(fp => {
    const buf = readFileSync(fp);
    const base64 = buf.toString("base64");
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: base64,
      },
    };
  });

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages: [{
      role: "user",
      content: [
        ...imageContent,
        {
          type: "text",
          text: `Is this a vertical (9:16) real estate property video suitable for Instagram Reels? Check:
1. Correct orientation (vertical, not sideways or upside down)
2. Not corrupted/black/glitched frames
3. Appears to be a home/property tour (interior or exterior of a house/neighborhood)

Respond with ONLY valid JSON: {"ok": true/false, "reason": "brief explanation"}`,
        },
      ],
    }],
  });

  const text = response.content[0]?.text?.trim();
  try {
    // Try to parse JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {}

  // If parsing fails, assume OK (fail-open)
  console.warn(`[QC] Could not parse vision response: "${text?.slice(0, 100)}" — assuming OK`);
  return { ok: true, reason: "Could not parse AI response, assuming OK" };
}
