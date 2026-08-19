#!/usr/bin/env node
/**
 * yt-teaser-backfill.mjs — cut the teaser for a video that ALREADY shipped.
 *
 * The build path cuts each new video's teaser while the takes are local
 * (yt-pipeline-main.js); video 1 was built before the feature existed, so its
 * takes have to be recovered first. Everything needed survives:
 *
 *   - the SCRIPT rides the topic_pick record's actedResult (kept there
 *     precisely because "this record is the only thing that survives
 *     between runs")
 *   - the CLIPS are still in Drive under YT Recordings/<requestId>
 *   - the MATCHER is transcript-based, so re-downloading and re-transcribing
 *     reproduces the same take->clip mapping the build used
 *
 * This script recovers, cuts, uploads the teaser to Drive and records it on
 * the video's log entry. IT DOES NOT DELIVER: the distribution sweep owns
 * delivery (gated on the publish flip, retried on failure, recorded once),
 * and the workflow job runs the pipeline right after this script so the
 * sweep fires in the same dispatch.
 *
 * Idempotent: an entry that already carries a teaser is left alone, so a
 * re-dispatch cannot cut a second teaser or double-deliver.
 */

import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadApprovals } from "../src/yt-approvals.js";
import { loadLog as loadVideoLog, saveLog as saveVideoLog } from "../src/yt-log.js";
import { ingestRecordings } from "../src/yt-ingest.js";
import { takesToRecord } from "../src/yt-recording-kit.js";
import { cutTeaser } from "../src/yt-teaser.js";
import { uploadToFolder, ensureFolder } from "../src/drive.js";

const REQUEST_ID = process.env.BACKFILL_REQUEST_ID || "topic_pick-2026-08-07-d5cddf9d";

async function main() {
  const approvals = loadApprovals();
  const record = (approvals.requests || []).find((r) => r.requestId === REQUEST_ID);
  const script = record?.actedResult?.script;
  if (!script) throw new Error(`no script on ${REQUEST_ID}'s actedResult — cannot recover the takes`);

  const videoLog = loadVideoLog();
  const entry = (videoLog.videos || []).find((v) => v.requestId === REQUEST_ID);
  if (!entry) throw new Error(`no video log entry for ${REQUEST_ID}`);
  if (entry.teaser?.driveFileId) {
    console.log(`[TeaserBackfill] ${entry.videoId} already has a teaser (${entry.teaser.driveFileId}) — nothing to do`);
    return;
  }

  console.log(`[TeaserBackfill] recovering takes for ${REQUEST_ID} — "${script.title}"`);
  const workDir = join(tmpdir(), `yt-teaser-backfill-${entry.videoId}`);
  mkdirSync(workDir, { recursive: true });

  try {
    const ingest = await ingestRecordings({
      requestId: REQUEST_ID,
      takes: takesToRecord(script),
      workDir,
      keepFiles: true,
    });
    if (!ingest.result || ingest.result.matches.length === 0) {
      throw new Error(`take recovery found nothing to match (state: ${ingest.state})`);
    }

    const recordings = {};
    for (const m of ingest.result.matches) {
      const clip = ingest.clips.find((c) => c.id === m.clipId);
      if (clip) recordings[m.takeId] = { path: clip.localPath || null, durationSeconds: clip.durationSeconds };
    }

    const teaser = await cutTeaser({ script, recordings, workDir });
    // The outputs subfolder — an output among the takes becomes a fake
    // "newest recording" on the next ingest (see isPipelineOutput).
    const up = await uploadToFolder(await ensureFolder("outputs", ingest.folderId), `teaser-${entry.videoId}.mp4`, readFileSync(teaser.path), "video/mp4");
    if (!up?.id) throw new Error("Drive upload returned no file id");

    saveVideoLog({
      ...videoLog,
      videos: videoLog.videos.map((v) =>
        v.videoId === entry.videoId
          ? { ...v, teaser: { driveFileId: up.id, seconds: teaser.seconds, hookLine: script.hook || null, cutAt: new Date().toISOString() } }
          : v
      ),
    });
    console.log(
      `[TeaserBackfill] ${entry.videoId}: teaser cut (${teaser.seconds}s, ${teaser.report.takes.map((t) => t.takeId).join(" + ")}) ` +
        `and recorded — the distribution sweep delivers it to the Trial tab`
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[TeaserBackfill] FAILED: ${err.message}`);
  process.exit(1);
});
