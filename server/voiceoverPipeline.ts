/**
 * voiceoverPipeline.ts — Fully automatic voiceover pipeline.
 * Runs: audio detection → script generation → TTS → video render with captions → auto-approve.
 * Called from generatePicksHandler when autoVoiceover is ON.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import * as db from "./db";
import { storageGetSignedUrl } from "./storage";
import { analyzeSourceAudio } from "./voiceoverAudioIntel";
import { generateVoiceoverScript } from "./voiceoverScript";
import { renderVoiceover } from "./voiceoverRender";

const WORK_DIR = "/tmp/voiceover-pipeline";
if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

export async function processFullVoiceover(pickId: number): Promise<{ status: string; jobId?: number }> {
  // 1. Get the pick and its video info
  const picks = await db.getDailyPicks(
    new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
  );
  const pick = picks.find(p => p.id === pickId);
  if (!pick) throw new Error(`Pick ${pickId} not found`);

  // Get the reel info for duration
  const reel = await db.getReelById(pick.videoId);
  if (!reel) throw new Error(`Reel ${pick.videoId} not found`);

  // Get the Drive video URL (stored as S3 key or full URL in driveVideoUrl column)
  if (!pick.driveVideoUrl) throw new Error(`No Drive video URL for pick ${pickId}`);
  let videoUrl = pick.driveVideoUrl;
  // If it's a storage key (not a full URL), resolve to a signed URL
  if (!videoUrl.startsWith("http")) {
    videoUrl = await storageGetSignedUrl(videoUrl);
  }

  // 2. Create the voiceover job
  const result = await db.insertVoiceoverJob({
    pickId,
    city: pick.city,
    status: "detecting",
    originalAudioMode: "duck",
  });
  const jobId = result.id;

  try {
    // 3. Download the source video for analysis
    const videoPath = join(WORK_DIR, `pick_${pickId}_source.mp4`);
    console.log(`[VoiceoverPipeline] Downloading source video for pick ${pickId}...`);
    const videoResp = await fetch(videoUrl);
    if (!videoResp.ok) throw new Error(`Failed to download video: ${videoResp.status}`);
    const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
    writeFileSync(videoPath, videoBuffer);

    // 4. Analyze audio
    await db.updateVoiceoverJob(jobId, { status: "detecting" });
    const audioAnalysis = await analyzeSourceAudio(videoPath);
    const hasSpeech = audioAnalysis.audioType === "speech";
    const audioMode = hasSpeech ? "duck" : "mute";
    await db.updateVoiceoverJob(jobId, {
      audioType: hasSpeech ? "speech" : "music_only",
      originalAudioMode: audioMode,
    });

    // 5. Generate script
    await db.updateVoiceoverJob(jobId, { status: "scripting" });
    // Use audio analysis duration (from ffprobe) since igReels doesn't have a duration column
    const videoDuration = audioAnalysis.durationSec > 0 ? audioAnalysis.durationSec : 30;
    const caption = pick.refreshedCaption ?? reel.caption ?? "";
    const scriptResult = await generateVoiceoverScript({
      videoDurationSec: videoDuration,
      caption,
      city: pick.city,
      audioType: hasSpeech ? "speech" : "music_only",
    });
    await db.updateVoiceoverJob(jobId, { script: scriptResult.script, status: "rendering" });

    // 6. Render video with voiceover + captions (TTS is done inside renderVoiceover)
    const renderResult = await renderVoiceover({
      sourceVideoPath: videoPath,
      script: scriptResult.script,
      originalAudioMode: audioMode,
      jobId,
    });

    // 7. Upload rendered video to S3
    const renderedVideoBuffer = readFileSync(renderResult.outputPath);
    const { storagePut } = await import("./storage");
    const storageKeyInput = `voiceover-rendered/pick_${pickId}_${Date.now()}.mp4`;
    const { key: actualStorageKey } = await storagePut(storageKeyInput, renderedVideoBuffer, "video/mp4");

    // 8. Update job as approved (auto-approve in automatic mode)
    await db.updateVoiceoverJob(jobId, {
      renderedVideoStorageKey: actualStorageKey,
      audioDurationSec: renderResult.audioDurationSec,
      charactersUsed: renderResult.charactersUsed,
      durationMismatchPct: renderResult.durationMismatchPct,
      status: "approved",
    });

    // 9. Cleanup temp files
    try {
      if (existsSync(videoPath)) unlinkSync(videoPath);
      if (existsSync(renderResult.outputPath)) unlinkSync(renderResult.outputPath);
    } catch { /* ignore cleanup errors */ }

    console.log(`[VoiceoverPipeline] Pick ${pickId} voiceover complete and auto-approved`);
    return { status: "approved", jobId };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.updateVoiceoverJob(jobId, {
      status: "failed",
      errorMessage: errMsg,
    });
    console.error(`[VoiceoverPipeline] Pick ${pickId} failed:`, errMsg);
    throw err;
  }
}
