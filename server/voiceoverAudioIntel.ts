/**
 * Audio Intelligence Module
 *
 * Detects whether a source video contains prominent speech (someone talking
 * to camera) vs. only music/ambient audio. Uses ffprobe audio analysis to
 * determine speech presence based on audio characteristics.
 *
 * Results:
 * - "speech": prominent voice detected — recommend muting original audio
 * - "music_only": only music/ambient — ideal for voiceover ducking
 * - "silent": no meaningful audio track
 * - "unknown": analysis failed or inconclusive
 */

import { execSync } from "child_process";
import { getFFmpegPath, getFFprobePath } from "./ffmpegPaths";

export type AudioType = "speech" | "music_only" | "silent" | "unknown";

interface AudioAnalysis {
  audioType: AudioType;
  confidence: "high" | "medium" | "low";
  details: string;
  durationSec: number;
}

/**
 * Analyze a video file's audio to detect speech vs music.
 * Uses ffprobe to get audio stream info and ffmpeg's silencedetect + volumedetect
 * to characterize the audio content.
 */
export async function analyzeSourceAudio(videoPath: string): Promise<AudioAnalysis> {
  const FFMPEG = getFFmpegPath();
  const FFPROBE = getFFprobePath();

  try {
    // Step 1: Get video duration and audio stream info
    const probeResult = execSync(
      `"${FFPROBE}" -v quiet -print_format json -show_streams -show_format "${videoPath}"`,
      { encoding: "utf-8", timeout: 30000 }
    );
    const probe = JSON.parse(probeResult);
    const audioStream = probe.streams?.find((s: any) => s.codec_type === "audio");
    const durationSec = Math.round(parseFloat(probe.format?.duration ?? "0"));

    if (!audioStream) {
      return { audioType: "silent", confidence: "high", details: "No audio stream found", durationSec };
    }

    // Step 2: Analyze audio volume levels
    const volumeResult = execSync(
      `"${FFMPEG}" -i "${videoPath}" -af "volumedetect" -f null /dev/null 2>&1 | grep -E "mean_volume|max_volume"`,
      { encoding: "utf-8", timeout: 60000 }
    );

    const meanMatch = volumeResult.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch = volumeResult.match(/max_volume:\s*([-\d.]+)\s*dB/);
    const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -100;
    const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : -100;

    // If audio is extremely quiet, it's effectively silent
    if (meanVolume < -50) {
      return { audioType: "silent", confidence: "high", details: `Very quiet audio (mean: ${meanVolume}dB)`, durationSec };
    }

    // Step 3: Use speech activity detection via spectral analysis
    // Speech has energy concentrated in 300Hz-3400Hz range
    // Music tends to have broader spectral distribution
    const spectralResult = execSync(
      `"${FFMPEG}" -i "${videoPath}" -af "asplit[a][b];[a]highpass=f=300,lowpass=f=3400,volumedetect[speech];[b]volumedetect[full]" -map "[speech]" -f null /dev/null 2>&1 | grep "mean_volume"`,
      { encoding: "utf-8", timeout: 60000 }
    ).trim();

    // Parse speech-band volume
    const speechBandMatch = spectralResult.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const speechBandVolume = speechBandMatch ? parseFloat(speechBandMatch[1]) : -100;

    // Speech-to-total ratio: if speech band is close to total volume, it's likely speech
    const speechRatio = speechBandVolume - meanVolume;

    // Step 4: Count silence gaps (speech has natural pauses, music is more continuous)
    let silenceCount = 0;
    try {
      const silenceResult = execSync(
        `"${FFMPEG}" -i "${videoPath}" -af "silencedetect=noise=-30dB:d=0.3" -f null /dev/null 2>&1 | grep -c "silence_start"`,
        { encoding: "utf-8", timeout: 60000 }
      ).trim();
      silenceCount = parseInt(silenceResult, 10) || 0;
    } catch {
      // grep returns exit 1 if no matches
      silenceCount = 0;
    }

    // Heuristic classification:
    // - Speech: speech band volume close to total (ratio > -6dB), many silence gaps
    // - Music: broader spectrum (ratio < -10dB), fewer silence gaps
    const silencePerSec = silenceCount / Math.max(durationSec, 1);

    if (speechRatio > -6 && silencePerSec > 0.3) {
      return {
        audioType: "speech",
        confidence: speechRatio > -3 ? "high" : "medium",
        details: `Speech detected (band ratio: ${speechRatio.toFixed(1)}dB, pauses/sec: ${silencePerSec.toFixed(2)})`,
        durationSec,
      };
    } else if (speechRatio < -10 && silencePerSec < 0.15) {
      return {
        audioType: "music_only",
        confidence: speechRatio < -14 ? "high" : "medium",
        details: `Music/ambient only (band ratio: ${speechRatio.toFixed(1)}dB, pauses/sec: ${silencePerSec.toFixed(2)})`,
        durationSec,
      };
    } else if (speechRatio > -8 && silencePerSec > 0.2) {
      // Borderline — likely speech with music background
      return {
        audioType: "speech",
        confidence: "low",
        details: `Likely speech with background music (band ratio: ${speechRatio.toFixed(1)}dB, pauses/sec: ${silencePerSec.toFixed(2)})`,
        durationSec,
      };
    } else {
      // Borderline — likely music with some vocal elements
      return {
        audioType: "music_only",
        confidence: "low",
        details: `Likely music/ambient (band ratio: ${speechRatio.toFixed(1)}dB, pauses/sec: ${silencePerSec.toFixed(2)})`,
        durationSec,
      };
    }
  } catch (err) {
    const e = err as Error;
    console.error("[AudioIntel] Analysis failed:", e.message);
    return { audioType: "unknown", confidence: "low", details: e.message, durationSec: 0 };
  }
}

/**
 * Get video duration in seconds using ffprobe.
 */
export function getVideoDuration(videoPath: string): number {
  const FFPROBE = getFFprobePath();
  try {
    const result = execSync(
      `"${FFPROBE}" -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: "utf-8", timeout: 15000 }
    ).trim();
    return Math.round(parseFloat(result));
  } catch {
    return 0;
  }
}
