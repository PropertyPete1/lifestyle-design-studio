"""State DB tests — the exactly-once ledger and the rolling daily cap."""
import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from yt_comments import state  # noqa: E402
from yt_comments.config import CT  # noqa: E402


class TestState(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.conn = state.get_db(Path(self._tmp.name) / "state.sqlite3")

    def tearDown(self):
        self.conn.close()
        self._tmp.cleanup()

    def test_schema_columns_match_spec(self):
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(replied_comments)")}
        self.assertEqual(
            cols, {"comment_id", "video_id", "channel_id", "replied_at", "reply_text"}
        )

    def test_record_and_dedupe(self):
        self.assertFalse(state.already_replied(self.conn, "c1"))
        state.record_reply(self.conn, "c1", "v1", "UCchan", "first reply")
        self.assertTrue(state.already_replied(self.conn, "c1"))

        # A retry must not overwrite or double-count.
        state.record_reply(self.conn, "c1", "v1", "UCchan", "second reply")
        rows = self.conn.execute("SELECT reply_text FROM replied_comments").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["reply_text"], "first reply")

    def test_replied_ids(self):
        for cid in ("a", "b", "c"):
            state.record_reply(self.conn, cid, "v", "UCchan", "text")
        self.assertEqual(state.replied_ids(self.conn), {"a", "b", "c"})

    def test_daily_window_counts_only_recent(self):
        state.record_reply(self.conn, "fresh", "v", "UCchan", "now")

        old = (dt.datetime.now(CT) - dt.timedelta(hours=40)).isoformat(timespec="seconds")
        self.conn.execute(
            "INSERT INTO replied_comments VALUES (?,?,?,?,?)",
            ("stale", "v", "UCchan", old, "yesterday"),
        )
        self.conn.commit()

        self.assertEqual(state.replies_in_last_hours(self.conn, 24), 1)
        self.assertEqual(state.replies_in_last_hours(self.conn, 72), 2)

    def test_recent_reply_texts_newest_first(self):
        base = dt.datetime.now(CT)
        for i, cid in enumerate(("old", "mid", "new")):
            stamp = (base - dt.timedelta(hours=3 - i)).isoformat(timespec="seconds")
            self.conn.execute(
                "INSERT INTO replied_comments VALUES (?,?,?,?,?)",
                (cid, "v", "UCchan", stamp, f"reply {cid}"),
            )
        self.conn.commit()
        self.assertEqual(
            state.recent_reply_texts(self.conn, 2), ["reply new", "reply mid"]
        )

    def test_record_run(self):
        state.record_run(self.conn, "2026-07-29T10:00:00-06:00", {"replied": 3})
        row = self.conn.execute("SELECT stats FROM runs").fetchone()
        self.assertIn('"replied": 3', row["stats"])


if __name__ == "__main__":
    unittest.main()
