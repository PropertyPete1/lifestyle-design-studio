/**
 * Burned-In Captions — Synced to voiceover audio using word-level timestamps.
 * 
 * Flow:
 * 1. Get word-level timestamps from ElevenLabs alignment data OR Whisper on the TTS audio
 * 2. Group words into 2-4 word chunks
 * 3. Generate an ASS subtitle file with Reels-style formatting
 * 4. Burn into video with ffmpeg (after audio merge)
 * 
 * Only applied when voiceover IS added. Videos with existing speech get NO captions.
 */
import { execSync } from "child_process";
import { writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const VOICEOVER_DELAY_MS = 500; // Must match the adelay=500 in mergeAudioWithVideo

/**
 * Get word-level timestamps by running Whisper on the TTS audio file.
 * Returns array of { word, start, end } in seconds.
 */
export function getWordTimestamps(audioPath) {
  // Use Whisper with word_timestamps=True via a small Python script
  const scriptPath = join(tmpdir(), `whisper_words_${Date.now()}.py`);
  const outputPath = join(tmpdir(), `word_times_${Date.now()}.json`);

  const pyScript = `
import whisper
import json
import sys
import io
import contextlib

model = whisper.load_model("tiny")
f = io.StringIO()
with contextlib.redirect_stdout(f):
    result = model.transcribe(
        "${audioPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}",
        language="en",
        fp16=False,
        verbose=False,
        word_timestamps=True,
    )

words = []
for segment in result.get("segments", []):
    for word_info in segment.get("words", []):
        words.append({
            "word": word_info["word"].strip(),
            "start": round(word_info["start"], 3),
            "end": round(word_info["end"], 3),
        })

with open("${outputPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", "w") as f:
    json.dump(words, f)
`;

  writeFileSync(scriptPath, pyScript);

  try {
    execSync(`python3 "${scriptPath}"`, { timeout: 60000, stdio: "pipe" });
    if (existsSync(outputPath)) {
      const data = JSON.parse(execSync(`cat "${outputPath}"`, { encoding: "utf-8" }));
      console.log(`[Captions] Got ${data.length} word timestamps from Whisper`);
      return data;
    }
  } catch (err) {
    console.warn(`[Captions] Whisper word timestamps failed: ${err.message?.slice(0, 100)}`);
  } finally {
    try { unlinkSync(scriptPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }

  return [];
}

/**
 * Try to get word-level timestamps from ElevenLabs alignment endpoint.
 * Falls back to Whisper if not available.
 */
export async function getWordTimestampsFromElevenLabs(script, audioPath) {
  // ElevenLabs provides alignment data via the /text-to-speech/{voice_id}/with-timestamps endpoint
  // For now, we use Whisper as the reliable fallback since it's already installed
  // TODO: Switch to ElevenLabs alignment API when available in our plan
  console.log("[Captions] Using Whisper for word-level timestamps...");
  return getWordTimestamps(audioPath);
}

/**
 * Group words into chunks of 2-4 words for Reels-style display.
 * Tries to break at natural pause points.
 */
export function groupWordsIntoChunks(words, maxWordsPerChunk = 4) {
  if (!words || words.length === 0) return [];

  const chunks = [];
  let currentChunk = [];

  for (let i = 0; i < words.length; i++) {
    currentChunk.push(words[i]);

    const isLastWord = i === words.length - 1;
    const chunkSize = currentChunk.length;

    // Decide whether to break here
    let shouldBreak = false;

    if (chunkSize >= maxWordsPerChunk) {
      shouldBreak = true;
    } else if (chunkSize >= 2) {
      // Break at natural pauses (gap > 200ms between words)
      if (!isLastWord && words[i + 1]) {
        const gap = words[i + 1].start - words[i].end;
        if (gap > 0.2) shouldBreak = true;
      }
      // Break after punctuation
      const word = words[i].word;
      if (word.endsWith(".") || word.endsWith(",") || word.endsWith("!") || word.endsWith("?")) {
        if (chunkSize >= 2) shouldBreak = true;
      }
    }

    if (shouldBreak || isLastWord) {
      chunks.push({
        text: currentChunk.map(w => w.word).join(" "),
        start: currentChunk[0].start,
        end: currentChunk[currentChunk.length - 1].end,
      });
      currentChunk = [];
    }
  }

  return chunks;
}

/**
 * Format time in seconds to ASS timestamp format: H:MM:SS.cc
 */
function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Generate an ASS subtitle file with Reels-style formatting.
 * - Large bold font
 * - White text with heavy black outline
 * - Positioned in lower third but above Instagram's bottom safe zone (~15%)
 * - Accounts for voiceover delay offset
 */
export function generateASSFile(chunks, videoWidth = 1080, videoHeight = 1920) {
  const outputPath = join(tmpdir(), `captions_${Date.now()}.ass`);

  // Position: top-center, 20% from top (below IG username overlay at ~12%)
  // Video's own price/location overlays are typically at 55-70% from top — no collision
  const marginV = Math.round(videoHeight * 0.20);

  // Font size relative to video width (9pt ratio for 1080w)
  const fontSize = Math.round(videoWidth * 0.065); // ~70px on 1080w

  const header = `[Script Info]
Title: Voiceover Captions
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,8,10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = chunks.map(chunk => {
    // Add voiceover delay offset (500ms)
    const startTime = chunk.start + VOICEOVER_DELAY_MS / 1000;
    const endTime = chunk.end + VOICEOVER_DELAY_MS / 1000;
    // Uppercase for Reels style impact
    const text = chunk.text.toUpperCase();
    return `Dialogue: 0,${formatASSTime(startTime)},${formatASSTime(endTime)},Default,,0,0,0,,${text}`;
  });

  const content = header + events.join("\n") + "\n";
  writeFileSync(outputPath, content);
  console.log(`[Captions] Generated ASS file with ${chunks.length} subtitle events`);
  return outputPath;
}

/**
 * Burn subtitles into video using ffmpeg.
 * This re-encodes the video (necessary for subtitle overlay).
 * 
 * @param {string} videoPath - Input video (already merged with voiceover audio)
 * @param {string} assPath - ASS subtitle file
 * @returns {string} Path to the output video with burned captions
 */
export function burnCaptions(videoPath, assPath) {
  const outputPath = join(tmpdir(), `captioned_${Date.now()}.mp4`);

  // Use libx264 for compatibility, CRF 18 for near-lossless quality
  // The ass filter handles all the styling from the ASS file
  const cmd = `ffmpeg -y -i "${videoPath}" -vf "ass=${assPath}" -c:v libx264 -preset fast -crf 18 -c:a copy "${outputPath}" 2>&1`;

  try {
    execSync(cmd, { encoding: "utf-8", timeout: 180000 });
    console.log(`[Captions] Burned captions into video: ${outputPath}`);
    return outputPath;
  } catch (err) {
    console.error(`[Captions] ffmpeg burn failed: ${err.message?.slice(0, 200)}`);
    throw new Error("Caption burn failed");
  }
}

/**
 * Full burned-captions pipeline.
 * Call AFTER voiceover merge but BEFORE upload.
 * 
 * @param {string} mergedVideoPath - Video with voiceover already merged
 * @param {string} voiceoverAudioPath - The TTS audio file (for Whisper timing)
 * @param {string} script - The voiceover script text
 * @returns {string} Path to final video with burned captions (or original if failed)
 */
export async function processBurnedCaptions(mergedVideoPath, voiceoverAudioPath, script) {
  console.log("[Captions] Starting burned-captions pipeline...");

  try {
    // Step 1: Get word-level timestamps
    const words = await getWordTimestampsFromElevenLabs(script, voiceoverAudioPath);
    if (!words || words.length === 0) {
      console.warn("[Captions] No word timestamps available — skipping captions");
      return mergedVideoPath;
    }

    // Step 2: Group into 2-4 word chunks
    const chunks = groupWordsIntoChunks(words, 4);
    if (chunks.length === 0) {
      console.warn("[Captions] No chunks generated — skipping captions");
      return mergedVideoPath;
    }
    console.log(`[Captions] ${chunks.length} caption chunks (${words.length} words)`);

    // Step 3: Get video dimensions for proper positioning
    let width = 1080, height = 1920;
    try {
      const dims = execSync(
        `ffprobe -v quiet -show_entries stream=width,height -of csv=p=0 "${mergedVideoPath}"`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim().split("\n")[0];
      const [w, h] = dims.split(",").map(Number);
      if (w && h) { width = w; height = h; }
    } catch {}

    // Step 4: Generate ASS subtitle file
    const assPath = generateASSFile(chunks, width, height);

    // Step 5: Burn into video
    const captionedPath = burnCaptions(mergedVideoPath, assPath);

    // Cleanup ASS file
    try { unlinkSync(assPath); } catch {}

    return captionedPath;
  } catch (err) {
    console.error(`[Captions] Pipeline failed: ${err.message} — returning video without captions`);
    return mergedVideoPath;
  }
}
