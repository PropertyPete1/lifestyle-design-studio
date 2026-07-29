"""Comment filtering — decides what is worth a reply.

Every rule returns a short machine-readable reason so the run log and the
weekly digest can show *why* something was skipped, not just that it was.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

# --- links -----------------------------------------------------------------
# Deliberately broad: a comment that already contains a link either is spam or
# already has its own call to action, and either way we don't want to reply
# under it with "link in bio".
LINK_PATTERNS = [
    re.compile(r"https?://", re.I),
    re.compile(r"\bwww\.", re.I),
    re.compile(r"\bt\.me/", re.I),
    re.compile(r"\bwa\.me/", re.I),
    re.compile(r"\bbit\.ly\b", re.I),
    re.compile(r"\btinyurl\b", re.I),
    # bare domains: "example.com", "foo.co/bar". Excludes decimals ("3.5")
    # by requiring a known-ish TLD of 2+ letters after a word character.
    re.compile(r"\b[a-z0-9][a-z0-9-]{1,}\.(com|net|org|io|co|xyz|shop|link|info|biz|ru|cn)\b", re.I),
]

# --- spam ------------------------------------------------------------------
SPAM_PHRASES = [
    "sub4sub", "sub 4 sub", "sub2sub", "subscribe to my",
    "check out my channel", "check my channel", "visit my channel",
    "watch my video", "my new video", "promote your",
    "dm me", "d.m me", "text me on", "whatsapp", "telegram",
    "investment opportunity", "crypto", "bitcoin", "forex",
    "make money fast", "earn $", "work from home",
    "free followers", "buy followers", "cheap views",
    "click the link", "link in my bio", "swipe up",
    "casino", "betting", "loan offer", "hacker", "recover your account",
    "gift card", "giveaway winner", "you have been selected",
]

CONTACT_PATTERNS = [
    # Phone-ish runs of 7+ digits, allowing spaces/dashes/parens.
    re.compile(r"(?:\+?\d[\d\s().-]{6,}\d)"),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),          # email
    re.compile(r"@[A-Za-z0-9_]{4,}\s*(?:on|@)\s*(?:ig|insta|instagram|tg|telegram)", re.I),
]

REPEATED_CHAR = re.compile(r"(.)\1{5,}")              # "aaaaaaa", "!!!!!!!"
HASHTAG = re.compile(r"#\w+")

# Keycap emoji ("1️⃣", "#️⃣") are a digit/# plus VS16 plus U+20E3. Stripping
# them character-by-character would leave the bare digit behind, so "1️⃣2️⃣3️⃣4️⃣"
# would read as four characters of real content. Remove whole sequences first.
KEYCAP = re.compile("[0-9#*]️?⃣")

MIN_MEANINGFUL_CHARS = 4
MAX_COMMENT_CHARS = 1500          # walls of text are almost always copypasta


@dataclass
class Verdict:
    """Outcome of filtering one comment."""

    keep: bool
    reason: str = ""

    def __bool__(self) -> bool:  # lets callers write `if verdict:`
        return self.keep


KEEP = Verdict(True)


def _is_emoji_or_symbol(ch: str) -> bool:
    """True for emoji, pictographs, symbols, and modifiers."""
    if ch in ("‍", "️", "⃣"):          # ZWJ, VS16, keycap
        return True
    category = unicodedata.category(ch)
    if category in ("So", "Sk", "Sm", "Sc", "Cf", "Co"):
        return True
    code = ord(ch)
    return (
        0x1F000 <= code <= 0x1FAFF      # emoji blocks
        or 0x2600 <= code <= 0x27BF     # misc symbols + dingbats
        or 0x1F1E6 <= code <= 0x1F1FF   # regional indicators (flags)
    )


def meaningful_text(text: str) -> str:
    """The comment stripped of emoji, punctuation, and whitespace.

    What's left is the actual language content — the basis for both the
    emoji-only and the too-short checks.
    """
    kept = []
    for ch in KEYCAP.sub("", text):
        if _is_emoji_or_symbol(ch):
            continue
        if unicodedata.category(ch).startswith(("P", "Z", "C")):
            continue
        if ch.isspace():
            continue
        kept.append(ch)
    return "".join(kept)


def contains_link(text: str) -> bool:
    return any(p.search(text) for p in LINK_PATTERNS)


def looks_like_spam(text: str) -> tuple[bool, str]:
    """Heuristic spam check. Returns (is_spam, which_signal)."""
    lowered = text.lower()

    for phrase in SPAM_PHRASES:
        if phrase in lowered:
            return True, f"spam_phrase:{phrase}"

    for pattern in CONTACT_PATTERNS:
        if pattern.search(text):
            return True, "spam_contact_details"

    if REPEATED_CHAR.search(text):
        return True, "spam_repeated_chars"

    if len(HASHTAG.findall(text)) >= 4:
        return True, "spam_hashtag_stuffing"

    letters = [c for c in text if c.isalpha()]
    if len(letters) >= 15:
        upper_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
        if upper_ratio > 0.7:
            return True, "spam_all_caps"

    if len(text) > MAX_COMMENT_CHARS:
        return True, "spam_wall_of_text"

    return False, ""


def screen(
    thread,
    *,
    own_channel_ids: set[str],
    replied: set[str],
    max_age_days: int,
    skip_if_reply_count_at_least: int,
) -> Verdict:
    """Run every rule against one CommentThread.

    Order matters only for the quality of the logged reason; all rules are
    independent. Cheapest and most decisive checks come first.
    """
    if thread.comment_id in replied:
        return Verdict(False, "already_replied")

    if thread.author_channel_id and thread.author_channel_id in own_channel_ids:
        return Verdict(False, "own_comment")

    if not thread.can_reply:
        return Verdict(False, "replies_disabled")

    # A thread that already has replies was probably handled — by a human, or
    # by a run whose state push failed. Bail rather than risk a double reply.
    if thread.total_reply_count >= skip_if_reply_count_at_least:
        if any(a in own_channel_ids for a in thread.reply_author_channel_ids):
            return Verdict(False, "already_answered_by_us")
        return Verdict(False, f"thread_has_{thread.total_reply_count}_replies")

    age = thread.age_days
    if age is None:
        return Verdict(False, "no_timestamp")
    if age > max_age_days:
        return Verdict(False, f"older_than_{max_age_days}d")

    text = thread.text
    if not text:
        return Verdict(False, "empty")

    if contains_link(text):
        return Verdict(False, "contains_link")

    core = meaningful_text(text)
    if not core:
        return Verdict(False, "emoji_only")
    if len(core) < MIN_MEANINGFUL_CHARS:
        return Verdict(False, "too_short")

    is_spam, signal = looks_like_spam(text)
    if is_spam:
        return Verdict(False, signal)

    return KEEP
