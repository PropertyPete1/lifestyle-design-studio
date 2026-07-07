# ElevenLabs API Research — Voiceover Pipeline Options

## Key Findings (Jul 7, 2026)

### Option 1: ElevenLabs Studio API (Video + Voiceover + Captions in one)
- **Status: NOT AVAILABLE** — "The ElevenCreative Studio API is only available upon request. To get access, contact sales."
- Requires Enterprise plan or sales contact
- Would be ideal (upload video, add voiceover track, add captions, export video) but NOT accessible on Creator tier
- Source: https://elevenlabs.io/docs/api-reference/studio-api-information

### Option 2: ElevenLabs Dubbing API (V1)
- **Available via API** at POST https://api.elevenlabs.io/v1/dubbing
- Designed for TRANSLATION (dub from one language to another)
- Accepts video file or source_url, target_lang required
- Returns a dubbed video with translated audio
- **NOT suitable for our use case** — we want to ADD a voiceover, not translate existing speech
- Dubbing v2 API "not yet live but expected to launch in coming weeks"
- Source: https://elevenlabs.io/docs/api-reference/dubbing/create

### Option 3: ElevenLabs TTS API (Audio only)
- **Available** — POST /v1/text-to-speech/{voice_id}
- Returns MP3/WAV audio file of the voiceover
- Does NOT combine with video or add captions
- We already have this working (server/elevenlabs.ts)

### Option 4: @ffmpeg-installer/ffmpeg npm package
- Ships a static ffmpeg binary inside node_modules
- Works on Cloud Run / serverless Node environments
- Can combine video + audio + captions (ASS/SRT subtitles)
- **This is the practical solution** for production deployment
- Source: https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg

### Option 5: Creatomate API (third-party)
- Cloud video rendering API
- Can take video + audio + text overlays and render final video
- Costs money per render
- Source: https://creatomate.com/blog/how-to-create-voice-over-videos-using-an-api

## Conclusion
ElevenLabs does NOT have a public API that can take a video, add voiceover audio, and add captions all in one step. Their Studio can do it in the UI but the API requires Enterprise access.

**Best path forward:** 
1. Use ElevenLabs TTS API to generate the voiceover audio (already working)
2. Use @ffmpeg-installer/ffmpeg (npm package) to combine video + audio + captions in production
3. This avoids system ffmpeg dependency — the binary ships inside node_modules
