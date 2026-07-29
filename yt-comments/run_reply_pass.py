#!/usr/bin/env python3
"""Entry point for one comment-reply pass.

    python3 run_reply_pass.py            # live
    DRY_RUN=true python3 run_reply_pass.py   # generate replies, post nothing
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from yt_comments.main import run  # noqa: E402

if __name__ == "__main__":
    sys.exit(run())
