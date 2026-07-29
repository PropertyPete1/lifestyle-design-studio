"""Encrypted SQLite state.

The DB is plain SQLite while a workflow is running; the `yt-state-sync`
composite action encrypts it (AES-256-CBC via openssl, keyed on
STATE_ENCRYPTION_KEY) before committing it to the orphan `state` branch —
the same pattern used in LDR-Automation-Clean.

Tables
  replied_comments — the exactly-once ledger. A comment_id in here is never
                     replied to again, which is the whole safety story: the
                     cron fires every 20 minutes and re-lists the same threads.
  runs             — one row per pass, for the weekly digest.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import sqlite3
from pathlib import Path

from .config import now_ct, now_iso

LOGGER = logging.getLogger("yt.state")

SCHEMA = """
CREATE TABLE IF NOT EXISTS replied_comments (
    comment_id  TEXT PRIMARY KEY,   -- the parent (top-level) comment we replied to
    video_id    TEXT,
    channel_id  TEXT,
    replied_at  TEXT,               -- ISO8601, Central Time
    reply_text  TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT,
    finished_at TEXT,
    stats       TEXT                -- JSON
);

CREATE INDEX IF NOT EXISTS idx_replied_at ON replied_comments (replied_at);
CREATE INDEX IF NOT EXISTS idx_replied_channel ON replied_comments (channel_id);
"""


def get_db(path: Path | str) -> sqlite3.Connection:
    """Open (and initialize) the state DB."""
    db_path = Path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def already_replied(conn: sqlite3.Connection, comment_id: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM replied_comments WHERE comment_id = ?", (comment_id,)
        ).fetchone()
        is not None
    )


def replied_ids(conn: sqlite3.Connection) -> set[str]:
    """Every comment_id we've replied to — one query beats one per comment."""
    return {r["comment_id"] for r in conn.execute("SELECT comment_id FROM replied_comments")}


def record_reply(
    conn: sqlite3.Connection,
    comment_id: str,
    video_id: str,
    channel_id: str,
    reply_text: str,
) -> None:
    """Log a posted reply. INSERT OR IGNORE so a retry can't double-count."""
    conn.execute(
        "INSERT OR IGNORE INTO replied_comments "
        "(comment_id, video_id, channel_id, replied_at, reply_text) VALUES (?,?,?,?,?)",
        (comment_id, video_id, channel_id, now_iso(), reply_text),
    )
    conn.commit()


def replies_in_last_hours(conn: sqlite3.Connection, hours: int = 24) -> int:
    """Count replies inside a rolling window — backs the daily quota guard.

    The cutoff is built in Python with the same CT `isoformat(timespec=...)`
    shape every row is written with, so the lexicographic comparison is valid.
    Letting SQLite's `datetime('now', ...)` produce the bound would not work:
    it emits UTC in `YYYY-MM-DD HH:MM:SS` form, which does not sort against
    our offset-bearing `...THH:MM:SS-06:00` strings.
    """
    cutoff = (now_ct() - dt.timedelta(hours=hours)).isoformat(timespec="seconds")
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM replied_comments WHERE replied_at >= ?",
        (cutoff,),
    ).fetchone()
    return int(row["n"] or 0)


def recent_reply_texts(conn: sqlite3.Connection, limit: int = 25) -> list[str]:
    """Most recent replies, newest first — fed to Claude as 'do not echo these'."""
    return [
        r["reply_text"]
        for r in conn.execute(
            "SELECT reply_text FROM replied_comments ORDER BY replied_at DESC LIMIT ?",
            (int(limit),),
        )
        if r["reply_text"]
    ]


def record_run(conn: sqlite3.Connection, started_at: str, stats: dict) -> None:
    conn.execute(
        "INSERT INTO runs (started_at, finished_at, stats) VALUES (?,?,?)",
        (started_at, now_iso(), json.dumps(stats, sort_keys=True)),
    )
    conn.commit()
