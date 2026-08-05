#!/usr/bin/env python3
"""
Transcribe one recorded take, in full.

Usage: python3 transcribe-take.py <media_path> [model]

Output (JSON to stdout):
  {"ok": true, "transcript": "...", "language": "en", "duration": 24.3}
  {"ok": false, "error": "..."}

DELIBERATELY SEPARATE FROM detect-speech.py. That script answers a yes/no
question ("is anyone talking?") on the posting path, runs the tiny model, and
truncates aggressively — it is production-critical and tuned for its own job.

This one answers a different question: what EXACTLY did he say, so it can be
matched against a known script take. That needs the whole transcript and a more
accurate model, and it runs on a weekly job where a few extra seconds per clip
costs nothing. Sharing one script between the two would mean compromising both.

Defaults to the "base" model: noticeably better than tiny on connected speech,
still CPU-friendly on a 4-core runner. Matching is fuzzy (see yt-take-match.js),
so the transcript does not have to be perfect — it has to be good enough to tell
one take from another, and base clears that comfortably.
"""
import sys
import json
import os
import tempfile
import subprocess

DEFAULT_MODEL = os.environ.get("YT_WHISPER_MODEL", "base")


def extract_audio(media_path, output_path):
    """16kHz mono WAV — Whisper's expected input."""
    cmd = [
        "ffmpeg", "-y", "-i", media_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=300)
    return result.returncode == 0


def transcribe(audio_path, model_name):
    import io
    import contextlib
    import whisper

    model = whisper.load_model(model_name)
    # Whisper prints "Detected language: ..." to stdout even with verbose=False,
    # which would corrupt our JSON-only stdout contract.
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        result = model.transcribe(
            audio_path,
            language="en",   # Peter records in English; pinning it avoids
                             # misdetection on short clips with music behind them.
            fp16=False,
            verbose=False,
        )
    segments = result.get("segments") or []
    duration = segments[-1].get("end", 0.0) if segments else 0.0
    return {
        "ok": True,
        "transcript": (result.get("text") or "").strip(),
        "language": result.get("language", "en"),
        "duration": round(float(duration), 2),
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: transcribe-take.py <media_path> [model]"}))
        return 1

    media_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_MODEL

    if not os.path.exists(media_path):
        print(json.dumps({"ok": False, "error": f"not found: {media_path}"}))
        return 1

    tmp_dir = tempfile.mkdtemp(prefix="yt-take-")
    audio_path = os.path.join(tmp_dir, "audio.wav")

    try:
        if not extract_audio(media_path, audio_path):
            print(json.dumps({"ok": False, "error": "ffmpeg could not extract audio"}))
            return 1
        print(json.dumps(transcribe(audio_path, model_name)))
        return 0
    except Exception as err:  # noqa: BLE001 — the caller needs the reason, whatever it is
        print(json.dumps({"ok": False, "error": f"{type(err).__name__}: {err}"}))
        return 1
    finally:
        try:
            os.remove(audio_path)
            os.rmdir(tmp_dir)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
