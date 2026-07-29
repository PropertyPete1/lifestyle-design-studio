"""Filter + reply-validation tests. No network, no credentials.

    cd yt-comments && python3 -m unittest discover tests -v
"""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from yt_comments import filters, replies  # noqa: E402
from yt_comments.youtube import CommentThread  # noqa: E402

OUR_CHANNEL = "UCours"
VIEWER = "UCviewer"


def thread(
    text="Love this breakdown, is Stone Oak still worth it at these rates?",
    *,
    comment_id="c1",
    author_channel_id=VIEWER,
    age_days=1.0,
    total_reply_count=0,
    can_reply=True,
    reply_authors=None,
):
    return CommentThread(
        thread_id=comment_id,
        comment_id=comment_id,
        video_id="v1",
        channel_id=OUR_CHANNEL,
        text=text,
        author_name="Viewer",
        author_channel_id=author_channel_id,
        published_at=dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=age_days),
        total_reply_count=total_reply_count,
        can_reply=can_reply,
        reply_author_channel_ids=reply_authors or [],
    )


def screen(t, replied=frozenset(), max_age_days=14):
    return filters.screen(
        t,
        own_channel_ids={OUR_CHANNEL},
        replied=set(replied),
        max_age_days=max_age_days,
        skip_if_reply_count_at_least=1,
    )


class TestScreen(unittest.TestCase):
    def test_keeps_a_normal_question(self):
        self.assertTrue(screen(thread()).keep)

    def test_skips_already_replied(self):
        v = screen(thread(comment_id="c9"), replied={"c9"})
        self.assertFalse(v.keep)
        self.assertEqual(v.reason, "already_replied")

    def test_skips_our_own_comment(self):
        # Without this the bot replies to its own replies, forever.
        v = screen(thread(author_channel_id=OUR_CHANNEL))
        self.assertFalse(v.keep)
        self.assertEqual(v.reason, "own_comment")

    def test_skips_thread_we_already_answered(self):
        v = screen(thread(total_reply_count=1, reply_authors=[OUR_CHANNEL]))
        self.assertFalse(v.keep)
        self.assertEqual(v.reason, "already_answered_by_us")

    def test_skips_thread_with_other_replies(self):
        v = screen(thread(total_reply_count=2, reply_authors=["UCsomeoneelse"]))
        self.assertFalse(v.keep)
        self.assertIn("thread_has_2_replies", v.reason)

    def test_skips_when_replies_disabled(self):
        self.assertEqual(screen(thread(can_reply=False)).reason, "replies_disabled")

    def test_skips_stale_comment(self):
        v = screen(thread(age_days=30), max_age_days=14)
        self.assertFalse(v.keep)
        self.assertEqual(v.reason, "older_than_14d")

    def test_keeps_comment_inside_the_window(self):
        self.assertTrue(screen(thread(age_days=13.5), max_age_days=14).keep)


class TestEmojiOnly(unittest.TestCase):
    def test_pure_emoji(self):
        # The keycap cases matter: naive per-character stripping leaves the bare
        # digits behind, so "1️⃣2️⃣3️⃣4️⃣" would read as real content.
        for text in ("🔥🔥🔥", "😍", "👍🏽", "🇺🇸🇺🇸", "❤️", "1️⃣2️⃣", "1️⃣2️⃣3️⃣4️⃣5️⃣"):
            with self.subTest(text=text):
                self.assertEqual(screen(thread(text)).reason, "emoji_only")

    def test_punctuation_only(self):
        self.assertIn(screen(thread("!!!")).reason, ("emoji_only", "spam_repeated_chars"))

    def test_emoji_plus_real_words_is_kept(self):
        self.assertTrue(screen(thread("🔥 this Frisco tour was so helpful, thanks!")).keep)

    def test_too_short(self):
        self.assertEqual(screen(thread("ok")).reason, "too_short")


class TestLinks(unittest.TestCase):
    def test_detects_links(self):
        for text in (
            "great video https://example.com/deals",
            "see www.spam.biz for more",
            "join t.me/cryptogains",
            "more at myrealestate.shop today",
        ):
            with self.subTest(text=text):
                self.assertTrue(filters.contains_link(text), text)

    def test_decimal_is_not_a_link(self):
        self.assertFalse(filters.contains_link("rates are around 6.5 percent now"))

    def test_link_comment_is_skipped(self):
        self.assertEqual(
            screen(thread("nice tour, full listings at https://foo.com")).reason,
            "contains_link",
        )


class TestSpam(unittest.TestCase):
    def test_flags_spam(self):
        cases = [
            "sub4sub anyone?",
            "check out my channel for daily uploads",
            "DM me on whatsapp for investment opportunity",
            "MAKE MONEY FAST WITH THIS ONE SIMPLE TRICK TODAY",
            "call me 210 555 0134",
            "email me at spam@spam.net",
            "aaaaaaaaaaa",
            "#realestate #texas #homes #investing #luxury",
        ]
        for text in cases:
            with self.subTest(text=text):
                is_spam, signal = filters.looks_like_spam(text)
                self.assertTrue(is_spam, f"{text!r} should be spam")
                self.assertTrue(signal)

    def test_does_not_flag_a_real_comment(self):
        cases = [
            "We're relocating from California in the spring — is Round Rock or Mueller better for a family of four?",
            "This is EXACTLY what I needed, thank you!",
            "How much are property taxes out in Boerne these days?",
        ]
        for text in cases:
            with self.subTest(text=text):
                is_spam, signal = filters.looks_like_spam(text)
                self.assertFalse(is_spam, f"{text!r} flagged as {signal}")


class TestReplyValidation(unittest.TestCase):
    def test_accepts_a_good_reply(self):
        ok, why = replies.validate(
            "Stone Oak still pencils out if you can hold a few years — "
            "we broke down the numbers, link in bio."
        )
        self.assertTrue(ok, why)

    def test_rejects_missing_bio_pointer(self):
        ok, why = replies.validate("Stone Oak is still a solid bet right now.")
        self.assertFalse(ok)
        self.assertEqual(why, "no_bio_pointer")

    def test_rejects_url(self):
        ok, why = replies.validate("Details here: https://ldr.com — link in bio too")
        self.assertFalse(ok)
        self.assertEqual(why, "contains_url")

    def test_rejects_phone_number(self):
        ok, why = replies.validate("Call 210-555-0134 or grab the link in bio")
        self.assertFalse(ok)
        self.assertEqual(why, "contains_phone_number")

    def test_rejects_assistant_voice(self):
        ok, why = replies.validate("As an AI, I cannot advise — link in bio")
        self.assertFalse(ok)
        self.assertEqual(why, "assistant_voice_leak")

    def test_rejects_internal_tags(self):
        ok, why = replies.validate("<thinking>hmm</thinking> link in bio")
        self.assertFalse(ok)
        self.assertEqual(why, "internal_tag_leak")

    def test_rejects_overlong(self):
        ok, why = replies.validate("link in bio " + "x" * 400)
        self.assertFalse(ok)
        self.assertTrue(why.startswith("too_long"))

    def test_accepts_bio_phrasing_variants(self):
        for text in (
            "we cover it in the video linked in bio",
            "the link's in my bio if you want the full breakdown",
            "grab the full list — link in profile",
        ):
            with self.subTest(text=text):
                self.assertTrue(replies.mentions_bio(text), text)

    def test_strips_wrapping_quotes(self):
        self.assertEqual(replies._strip_wrapping_quotes('"hello there"'), "hello there")
        self.assertEqual(replies._strip_wrapping_quotes("“hi”"), "hi")
        self.assertEqual(replies._strip_wrapping_quotes('say "hi" now'), 'say "hi" now')


class TestPause(unittest.TestCase):
    def test_pause_within_configured_band(self):
        for _ in range(50):
            self.assertGreaterEqual(replies.pause_seconds(3, 5), 3)
            self.assertLessEqual(replies.pause_seconds(3, 5), 5)


if __name__ == "__main__":
    unittest.main()
