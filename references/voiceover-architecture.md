# Voiceover Pipeline Architecture

## Files
- `server/voiceoverPipeline.ts` — Main orchestrator: processFullVoiceover(pickId)
- `server/voiceoverAudioIntel.ts` — Audio detection: analyzeSourceAudio(videoPath) → { audioType: "speech"|"music_only"|"silent"|"unknown", confidence, details, durationSec }
- `server/voiceoverScript.ts` — Script gen: generateVoiceoverScript({ videoDurationSec, caption, city, audioType }) → { script, wordCount, estimatedDurationSec, wordsPerSecond }
- `server/elevenlabs.ts` — TTS: generateSpeech(text, opts?) → { audio: Buffer, charactersUsed }; generateSpeechWithTimestamps(text, opts?) → { audio, charactersUsed, alignment: { words, wordStartTimesMs, wordEndTimesMs } }; getVoiceId() → "ymv1q5WLElzdmrHdtgsw" (Peters pro voice)
- `server/voiceoverRender.ts` — Full render: renderVoiceover({ sourceVideoPath, script, originalAudioMode, jobId }) → { outputPath, audioDurationSec, videoDurationSec, durationMismatchPct, atempoApplied, charactersUsed, audioStorageKey }
- `server/scheduledPublish.ts` — generatePicksHandler auto-starts voiceover; publishNowHandler uses rendered video if approved

## DB Tables
- `voiceover_jobs` — pickId, city, status (detecting|scripting|generating_audio|rendering|approved|failed|pending_approval|duration_mismatch|preview_ready), script, audioType, originalAudioMode, audioDurationSec, durationMismatchPct, charactersUsed, renderedVideoStorageKey, errorMessage
- `voiceover_budget` — month, charactersUsed, characterLimit (100000), jobId

## Flow (FULLY AUTOMATIC)
1. generatePicksHandler → checks autoVoiceover setting (default ON)
2. For each pick with driveVideoUrl → processFullVoiceover(pickId)
3. Pipeline: download video → analyzeSourceAudio → generateVoiceoverScript → renderVoiceover (which does TTS + duration match + assembly + captions) → upload to S3 → auto-approve
4. publishNowHandler → checks voiceover job status → if approved, uses renderedVideoStorageKey instead of Drive original

## UI (COMPLETED)
- AutoVoiceoverToggle (violet, next to AutoPilotToggle in header)
- VoiceoverPanel per pick card (shows status, script, audio type)
- VoiceoverBudget meter (monthly chars used/limit)

## Settings
- `autoVoiceover` in settings table (default "true" if null)
- tRPC: settings.getAutoVoiceover / settings.setAutoVoiceover

## User's Remaining Request
- Update reposts table UI to display final compressed file size and CRF value used
