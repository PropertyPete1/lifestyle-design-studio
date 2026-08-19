#!/usr/bin/env node
/**
 * probe-thumbnail-candidates.mjs — what would the face-thumbnail contest have
 * made for an ALREADY-SHIPPED video?
 *
 * Peter's acceptance test for the face-thumbnail feature is concrete: "prove
 * it on video 1's real takes and show me the 3 candidates it would have
 * made." This probe runs the exact production path — recover the takes from
 * Drive, pick the source (the dedicated thumbnail take when one exists, the
 * hook take otherwise), sample frames, run the expression contest, matte,
 * composite, score — and uploads every candidate plus the winner and the full
 * contest report as a workflow artifact.
 *
 * READ-MOSTLY: it downloads takes and writes an artifact. It uploads nothing
 * to Drive, changes no log, publishes nothing.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadApprovals } from "../../auto-poster/src/yt-approvals.js";
import { loadLog as loadVideoLog } from "../../auto-poster/src/yt-log.js";
import { ingestRecordings } from "../../auto-poster/src/yt-ingest.js";
import { takesToRecord } from "../../auto-poster/src/yt-recording-kit.js";
import { ON_CAMERA } from "../../auto-poster/src/yt-script.js";
import { buildFaceThumbnail } from "../../auto-poster/src/yt-thumbnail-face.js";

const REQUEST_ID = process.env.PROBE_REQUEST_ID || "topic_pick-2026-08-07-d5cddf9d";
const OUT_DIR = process.env.PROBE_OUT_DIR || "/tmp/thumbnail-probe";

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const record = (loadApprovals().requests || []).find((r) => r.requestId === REQUEST_ID);
  const script = record?.actedResult?.script;
  if (!script) throw new Error(`no script on ${REQUEST_ID}'s actedResult`);
  const entry = (loadVideoLog().videos || []).find((v) => v.requestId === REQUEST_ID);
  const hookText = entry?.thumbnailText;
  if (!hookText) throw new Error(`no thumbnailText on the log entry — nothing to composite`);
  const kicker = entry.market === "austin" ? "AUSTIN" : "SAN ANTONIO";

  console.log(`recovering takes for ${REQUEST_ID} — hook text "${hookText}"`);
  // The recovered clips stay OUTSIDE the artifact directory — the artifact is
  // three PNGs and a report, not gigabytes of source takes.
  const ingest = await ingestRecordings({
    requestId: REQUEST_ID,
    takes: takesToRecord(script),
    workDir: join(tmpdir(), "thumb-probe-takes"),
    keepFiles: true,
  });
  if (!ingest.result || ingest.result.matches.length === 0) {
    throw new Error(`take recovery matched nothing (state: ${ingest.state})`);
  }

  const recordings = {};
  for (const m of ingest.result.matches) {
    const clip = ingest.clips.find((c) => c.id === m.clipId);
    if (clip) recordings[m.takeId] = { path: clip.localPath || null, durationSeconds: clip.durationSeconds };
  }

  // Same source rule as the pipeline: thumbnail take first, hook take second.
  let source = null;
  if (recordings.thumbnail?.path) {
    source = { path: recordings.thumbnail.path, seconds: recordings.thumbnail.durationSeconds || 10, takeId: "thumbnail" };
    console.log("source: the dedicated THUMBNAIL take");
  } else {
    const takes = [];
    (script.sections || []).forEach((s, si) => (s.takes || []).forEach((t, ti) => takes.push({ ...t, id: t.id || `s${si + 1}t${ti + 1}`, sectionIndex: si })));
    const hook = takes.find((t) => t.mode === ON_CAMERA && t.sectionIndex === 0);
    const rec = hook ? recordings[hook.id] : null;
    if (!rec?.path) throw new Error("no thumbnail take and no hook-take recording — nothing to harvest a face from");
    source = { path: rec.path, seconds: rec.durationSeconds || null, takeId: hook.id };
    console.log(`source: FALLBACK — the hook take ${hook.id} (no thumbnail take was recorded for this video)`);
  }

  const face = await buildFaceThumbnail({ hookText, kicker, source, workDir: OUT_DIR });

  for (const c of face.candidates || []) {
    copyFileSync(c.path, join(OUT_DIR, `candidate-${c.index}${face.winner?.index === c.index ? "-WINNER" : ""}.png`));
  }
  writeFileSync(join(OUT_DIR, "contest-report.json"), JSON.stringify({
    requestId: REQUEST_ID,
    hookText,
    source: face.source,
    frames: face.frames,
    ranked: face.ranked || null,
    fallbacks: face.fallbacks,
    contestNote: face.contestNote || null,
    winnerIndex: face.winner?.index ?? null,
    reason: face.reason || null,
  }, null, 2) + "\n");

  if (!face.winner) {
    // A contest that could not produce a winner is a FINDING the artifact
    // documents, not a probe crash — the report says which stage fell over.
    console.log(`NO WINNER: ${face.reason || "see contest-report.json"}`);
    return;
  }
  console.log(`WINNER: candidate ${face.winner.index} (frame at ${face.winner.frameAt}s, ` +
    `trigger=${face.winner.emotionalTrigger ?? "?"}, legibility=${face.winner.legibility ?? "?"}, ` +
    `${face.winner.cutout ? "matted cutout" : "raw frame"})`);
  console.log(`${(face.candidates || []).length} candidate(s) in the artifact, losers included.`);
}

main().catch((err) => {
  console.error(`probe failed: ${err.message}`);
  process.exit(1);
});
