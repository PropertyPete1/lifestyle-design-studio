#!/usr/bin/env python3
"""
Speech Detection via OpenAI Whisper (tiny model).

Usage: python3 detect-speech.py <audio_file_path>

Output (JSON to stdout):
  {"has_speech": true/false, "transcript": "...", "language": "en", "confidence": 0.95}

Logic:
  - If Whisper transcribes meaningful words (>3 words, not just noise) → has_speech = true
  - If transcript is empty or just noise tokens → has_speech = false (music-only or silent)
"""
import sys
import json
import os
import tempfile
import subprocess

def extract_audio(video_path, output_path):
    """Extract audio from video as 16kHz mono WAV (Whisper's expected format)."""
    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        output_path
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=60)
    return result.returncode == 0

def detect_speech(audio_path):
    """Run Whisper tiny model on audio and determine if speech is present."""
    import whisper
    import io
    import contextlib
    
    model = whisper.load_model("tiny")
    # Suppress Whisper's 'Detected language: ...' output that leaks to stdout
    # even with verbose=False — this breaks our JSON-only stdout contract
    f = io.StringIO()
    with contextlib.redirect_stdout(f):
        result = model.transcribe(
            audio_path,
            language=None,  # Auto-detect
            fp16=False,     # CPU mode
            verbose=False,
        )
    
    transcript = result.get("text", "").strip()
    language = result.get("language", "unknown")
    
    # Determine if this is real speech vs music/noise
    # Whisper sometimes hallucinates on music (repeating phrases, nonsense)
    words = transcript.split()
    word_count = len(words)
    
    # Check for hallucination patterns (common with music)
    is_hallucination = False
    if word_count > 0:
        # Repeated phrases (hallucination on music)
        unique_words = set(w.lower().strip(".,!?") for w in words)
        uniqueness_ratio = len(unique_words) / word_count if word_count > 0 else 0
        
        # Very low uniqueness = likely hallucination on repetitive music
        if word_count > 10 and uniqueness_ratio < 0.3:
            is_hallucination = True
        
        # Check segments for low probability (no_speech_prob)
        segments = result.get("segments", [])
        if segments:
            avg_no_speech = sum(s.get("no_speech_prob", 0) for s in segments) / len(segments)
            if avg_no_speech > 0.5:
                is_hallucination = True
    
    # Decision: real speech if we have meaningful words and it's not hallucination
    has_speech = word_count >= 3 and not is_hallucination
    
    # Confidence based on no_speech_prob from segments
    segments = result.get("segments", [])
    if segments:
        avg_no_speech = sum(s.get("no_speech_prob", 0) for s in segments) / len(segments)
        confidence = 1.0 - avg_no_speech
    else:
        confidence = 0.5
    
    return {
        "has_speech": has_speech,
        "transcript": transcript[:500],  # Truncate for logging
        "language": language,
        "confidence": round(confidence, 3),
        "word_count": word_count,
        "is_hallucination": is_hallucination,
    }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect-speech.py <video_or_audio_path>"}))
        sys.exit(1)
    
    input_path = sys.argv[1]
    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File not found: {input_path}"}))
        sys.exit(1)
    
    # Extract audio to temp WAV
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    
    try:
        if not extract_audio(input_path, wav_path):
            # No audio stream — definitely no speech
            print(json.dumps({"has_speech": False, "transcript": "", "language": "none", "confidence": 1.0, "word_count": 0, "reason": "no_audio_stream"}))
            return
        
        # Check if WAV file has content (not empty)
        if os.path.getsize(wav_path) < 1000:
            print(json.dumps({"has_speech": False, "transcript": "", "language": "none", "confidence": 1.0, "word_count": 0, "reason": "empty_audio"}))
            return
        
        result = detect_speech(wav_path)
        print(json.dumps(result))
    
    except Exception as e:
        # On error, output error JSON (caller decides what to do)
        print(json.dumps({"error": str(e)[:200], "has_speech": None}))
        sys.exit(1)
    
    finally:
        try:
            os.unlink(wav_path)
        except:
            pass

if __name__ == "__main__":
    main()
