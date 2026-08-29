/**
 * ldt-text-reel.js — simple text-motion reels: animated type on the brand
 * ground, built from nothing but the claims list and ffmpeg.
 *
 * Five 1080x1920 plates — hook (in the variation engine's chosen style),
 * two pinned-claim beats, the price, the CTA — each held ~2.4s with a slow
 * ken-burns push-in and crossfaded into the next. The result is a ~11s
 * vertical video the reels surfaces accept, produced with zero operator
 * footage.
 *
 * SILENT ON PURPOSE. Music licensing is its own minefield (the long-form
 * pipeline keeps a whole MUSIC-LICENSING.md about it) and a text reel with
 * confidently unlicensed audio is a takedown waiting to happen. Platform
 * viewers add their own sound; the honest baseline ships none. "Brand-safe"
 * here means: our type, our colours, our claims, no borrowed assets at all.
 *
 * Copy rules are the carousel's: reelText() exposes every visible line for
 * the claims gate; the runner checks BEFORE rendering. Like the hook-plate
 * burn, assembly self-QCs its output (stream present, duration within
 * tolerance of the plan) and returns a reasoned failure rather than throwing
 * — a generated reel must never cost the slot; the slot-filler just moves to
 * the next format.
 */

import { writeFileSync, existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { carouselAngles, hookLineFor } from "./ldt-carousel-gen.js";
import { REEL_W, REEL_H, ldtFrame, bigType, accentRule, resolvePalette, renderLdtSlides, esc, fitSize } from "./ldt-design.js";
import { SANS } from "./carousel-render.js";
import { probeVideo } from "./reel-hook-burn.js";
import { ffmpeg } from "./yt-assemble.js";

export const PLATE_SECONDS = 2.4;
export const CROSSFADE_SECONDS = 0.4;
export const REEL_FPS = 30;
export const REEL_DURATION_TOLERANCE = 1.0;

const MARGIN = Math.round(REEL_W * 0.11);

/** The five plates' copy for an angle + hook style. */
export function reelCopy(angle, hookStyle, { brand = null }) {
  const keyword = brand?.cta?.keyword || "PRIMARY";
  return {
    hook: hookLineFor(angle, hookStyle),
    beats: [angle.solution[0], angle.solution[1]],
    price: "Solo starts at $99/mo. $0 setup. Cancel anytime, no contracts.",
    cta: `Comment ${keyword} and we'll send you the demo.`,
  };
}

/** Every visible line, for the claims gate. */
export function reelText(angle, hookStyle, { claims, brand = null }) {
  const copy = reelCopy(angle, hookStyle, { brand });
  return [copy.hook, ...copy.beats, copy.price, copy.cta, claims.product, claims.site].join("\n");
}

/** One reel plate: centred big type on the frame, with an eyebrow variant for the CTA. */
function reelPlateSvg(text, { palette, claims, size, accentEmphasis = false }) {
  const probeBlock = bigType({ text, x: MARGIN, startY: 0, size, palette, w: REEL_W });
  const startY = Math.round(REEL_H / 2 - probeBlock.height / 2) + Math.round(size * 0.4);
  const placed = bigType({
    text, x: MARGIN, startY, size, palette, w: REEL_W,
    fill: accentEmphasis ? palette.accent : palette.ink,
  });
  return ldtFrame({
    w: REEL_W, h: REEL_H, palette, product: claims.product, site: claims.site,
    inner: accentRule({ x: MARGIN, y: startY - size - 48, palette }) + "\n  " + placed.svg,
  });
}

/** The five plates as SVGs, in play order. */
export function reelPlateSvgs(angle, hookStyle, { claims, brand = null }) {
  const palette = resolvePalette(brand?.palette);
  const copy = reelCopy(angle, hookStyle, { brand });
  return [
    reelPlateSvg(copy.hook, { palette, claims, size: copy.hook.length > 60 ? 76 : 88 }),
    reelPlateSvg(copy.beats[0], { palette, claims, size: 62 }),
    reelPlateSvg(copy.beats[1], { palette, claims, size: 62 }),
    reelPlateSvg(copy.price, { palette, claims, size: 66, accentEmphasis: true }),
    (() => {
      const ctaLine = `Comment ${brand?.cta?.keyword || "PRIMARY"}`;
      const ctaSize = fitSize(ctaLine, 92, REEL_W - MARGIN * 2);
      return ldtFrame({
        w: REEL_W, h: REEL_H, palette, product: claims.product, site: claims.site,
        inner:
          `<text x="${MARGIN}" y="${Math.round(REEL_H * 0.42)}" font-family="${SANS}" font-size="54" fill="${palette.ink}">Want the demo?</text>\n  ` +
          `<text x="${MARGIN}" y="${Math.round(REEL_H * 0.50)}" font-family="${SANS}" font-size="${ctaSize}" font-weight="bold" fill="${palette.accent}">${esc(ctaLine)}</text>\n  ` +
          accentRule({ x: MARGIN, y: Math.round(REEL_H * 0.54), palette }),
      });
    })(),
  ];
}

/** Expected output duration for n plates under the crossfade chain. */
export function plannedDuration(plateCount, plateSeconds = PLATE_SECONDS, crossfade = CROSSFADE_SECONDS) {
  return plateCount * plateSeconds - (plateCount - 1) * crossfade;
}

/**
 * The ffmpeg argument list: each plate looped for its hold, a slow ken-burns
 * push-in per plate (the "motion" in text-motion), crossfaded in a chain.
 * Pure and exported — an xfade offset off by one hold renders fine and plays
 * wrong, which is exactly the class of bug an argument test catches cheaply.
 */
export function reelAssemblyArgs(platePaths, output, {
  plateSeconds = PLATE_SECONDS,
  crossfade = CROSSFADE_SECONDS,
  fps = REEL_FPS,
  w = REEL_W,
  h = REEL_H,
} = {}) {
  const args = ["-y"];
  for (const p of platePaths) {
    // Each plate enters as a SINGLE frame — no -loop. zoompan emits `d`
    // output frames PER INPUT FRAME, so a looped 72-frame still would become
    // 72×72 frames: a two-minute plate that renders without complaint. The
    // ffmpeg-argument class of bug, again.
    args.push("-i", p);
  }

  const frames = Math.round(plateSeconds * fps);
  const filters = platePaths.map((_, i) =>
    // The push-in: 1.00 → ~1.05 over the plate's hold. zoompan wants the
    // zoom expression in terms of the output frame number `on`.
    `[${i}:v]zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p[p${i}]`
  );

  let last = "[p0]";
  for (let i = 1; i < platePaths.length; i++) {
    const offset = Math.round((i * plateSeconds - i * crossfade) * 1000) / 1000;
    const out = i === platePaths.length - 1 ? "[v]" : `[x${i}]`;
    filters.push(`${last}[p${i}]xfade=transition=fade:duration=${crossfade}:offset=${offset}${out}`);
    last = out;
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[v]",
    "-an", // silent on purpose — see the module header
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output
  );
  return args;
}

/**
 * Render plates and assemble the reel. Returns
 * { ok, videoPath, reason, hookLine, duration_seconds } and NEVER throws —
 * self-QC included, same contract as the hook-plate burn.
 */
export async function renderTextReel(angle, hookStyle, {
  claims,
  brand = null,
  outputDir = tmpdir(),
  runFfmpeg = ffmpeg,
  probe = probeVideo,
} = {}) {
  const fail = (reason) => ({ ok: false, videoPath: null, reason, hookLine: hookLineFor(angle, hookStyle), duration_seconds: null });
  const stamp = Date.now();
  const platePaths = [];

  try {
    const svgs = reelPlateSvgs(angle, hookStyle, { claims, brand });
    const { pngs } = await renderLdtSlides(svgs, { w: REEL_W, h: REEL_H });
    for (const [i, png] of pngs.entries()) {
      const p = join(outputDir, `ldtreel_${stamp}_${i}.png`);
      writeFileSync(p, png);
      platePaths.push(p);
    }

    const outputPath = join(outputDir, `ldtreel_${stamp}.mp4`);
    try {
      runFfmpeg(reelAssemblyArgs(platePaths, outputPath));
    } catch (err) {
      try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best effort */ }
      return fail(`assembly failed: ${String(err.message || err).slice(0, 160)}`);
    }

    if (!existsSync(outputPath) || statSync(outputPath).size < 20 * 1024) {
      try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best effort */ }
      return fail("assembly produced no usable output file");
    }
    const planned = plannedDuration(platePaths.length);
    const dims = probe(outputPath);
    if (!dims || Math.abs(dims.duration - planned) > REEL_DURATION_TOLERANCE) {
      try { unlinkSync(outputPath); } catch { /* best effort */ }
      return fail(`output failed the structural check (planned ${planned.toFixed(1)}s, got ${dims ? dims.duration.toFixed(1) + "s" : "unreadable"})`);
    }

    return { ok: true, videoPath: outputPath, reason: null, hookLine: hookLineFor(angle, hookStyle), duration_seconds: dims.duration };
  } catch (err) {
    return fail(`unexpected failure: ${String(err.message || err).slice(0, 160)}`);
  } finally {
    for (const p of platePaths) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
    }
  }
}
