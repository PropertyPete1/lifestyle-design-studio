"""Reply generation via the Claude API.

There is no template. Every reply is generated fresh from the comment text,
and each attempt is shown the last ~25 replies we posted with an instruction
not to reuse their shape or opening — which is what keeps a channel's replies
from converging on one phrasing over time.
"""
from __future__ import annotations

import logging
import random
import re

from anthropic import Anthropic

LOGGER = logging.getLogger("yt.replies")

MAX_REPLY_CHARS = 280
MAX_ATTEMPTS = 3

# Any of these counts as pointing at the bio link. The model picks the wording;
# we only check that the pointer is actually there.
BIO_PHRASES = [
    "link in bio", "link in my bio", "link in the bio", "bio link",
    "link's in bio", "link is in bio", "link's in my bio", "link is in my bio",
    "linked in bio", "in the bio", "check the bio", "bio has the link",
    "link in profile", "link in our bio",
]

SYSTEM_PROMPT = """You write replies to YouTube comments on behalf of a real estate team's channel.

Your entire output is the reply text itself. No preamble, no quotation marks, no sign-off, no emoji unless it genuinely fits.

Rules for every reply:
- Under 240 characters. Two short sentences is the sweet spot; one is often better.
- Reference something specific the commenter actually said. If they named a neighborhood, a price, a worry, or a plan, that detail belongs in your reply. A reply that would fit under any comment is a failed reply.
- Point them to the link in the bio, in your own words, as a natural next step rather than a pitch.
- Sound like a person typing on their phone between showings: warm, direct, specific. Contractions are good. Marketing register is not.
- Never invent facts — no made-up prices, listings, statistics, dates, or promises. If they ask something you can't answer, acknowledge it and send them to the bio link.
- Never include a URL, phone number, or email. The bio link is the only pointer.
- Do not ask for a subscribe, like, or follow.
- Do not open with the commenter's name, "Great question", "Thanks for", "Absolutely", "Love this", or any other stock opener.

Vary sentence shape, length, and rhythm between replies. If two replies you write would read as interchangeable, rewrite one."""


class ReplyGenerationError(RuntimeError):
    pass


def _strip_wrapping_quotes(text: str) -> str:
    text = text.strip()
    pairs = [('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’")]
    for opener, closer in pairs:
        if len(text) > 1 and text.startswith(opener) and text.endswith(closer):
            return text[1:-1].strip()
    return text


def mentions_bio(text: str) -> bool:
    lowered = text.lower()
    return any(phrase in lowered for phrase in BIO_PHRASES)


def validate(text: str) -> tuple[bool, str]:
    """Gate a generated reply before it can be posted."""
    if not text:
        return False, "empty"
    if len(text) > MAX_REPLY_CHARS:
        return False, f"too_long:{len(text)}"
    if re.search(r"https?://|\bwww\.", text, re.I):
        return False, "contains_url"
    if re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text):
        return False, "contains_email"
    if re.search(r"\+?\d[\d\s().-]{6,}\d", text):
        return False, "contains_phone_number"
    if re.search(r"\b(as an ai|language model|i cannot|i can't help)\b", text, re.I):
        return False, "assistant_voice_leak"
    if re.search(r"</?thinking>|</?antml", text, re.I):
        return False, "internal_tag_leak"
    if "\n\n" in text:
        return False, "multi_paragraph"
    if not mentions_bio(text):
        return False, "no_bio_pointer"
    return True, ""


class ReplyWriter:
    def __init__(self, api_key: str, model: str) -> None:
        if not api_key:
            raise ReplyGenerationError("ANTHROPIC_API_KEY is not set")
        self._client = Anthropic(api_key=api_key, timeout=90.0)
        self._model = model
        # Replies generated during this run, so a single pass can't repeat
        # itself before anything is committed to the DB.
        self._this_run: list[str] = []

    def _user_prompt(
        self,
        comment_text: str,
        author_name: str,
        video_title: str,
        voice: str,
        recent_replies: list[str],
        attempt: int,
        last_failure: str = "",
    ) -> str:
        parts = [
            f"Channel voice:\n{voice}" if voice else "",
            f"Video the comment is on: {video_title}" if video_title else "",
            f"Commenter: {author_name}" if author_name else "",
            f"Their comment:\n{comment_text}",
        ]

        if recent_replies:
            shown = "\n".join(f"- {r}" for r in recent_replies[:25])
            parts.append(
                "Replies already posted recently. Do not reuse their openings, "
                f"sentence shapes, or phrasing:\n{shown}"
            )

        if attempt > 1:
            nudge = {
                "no_bio_pointer": "Your previous attempt never pointed to the link in the bio. Work that in naturally.",
                "too_long": "Your previous attempt was too long. Cut it to two short sentences.",
            }.get(last_failure.split(":")[0], f"Your previous attempt was rejected ({last_failure}). Fix it.")
            parts.append(f"{nudge} Write a different reply, not an edit of the last one.")

        parts.append("Write the reply now. Output only the reply text.")
        return "\n\n".join(p for p in parts if p)

    def write(
        self,
        comment_text: str,
        *,
        author_name: str = "",
        video_title: str = "",
        voice: str = "",
        recent_replies: list[str] | None = None,
    ) -> str:
        """Generate one validated reply, or raise ReplyGenerationError."""
        avoid = list(recent_replies or []) + self._this_run
        failure = ""

        for attempt in range(1, MAX_ATTEMPTS + 1):
            prompt = self._user_prompt(
                comment_text, author_name, video_title, voice, avoid, attempt, failure
            )

            response = self._client.messages.create(
                model=self._model,
                max_tokens=2000,
                system=[{"type": "text", "text": SYSTEM_PROMPT}],
                output_config={"effort": "low"},
                messages=[{"role": "user", "content": prompt}],
            )

            if response.stop_reason == "refusal":
                raise ReplyGenerationError("Claude declined to write a reply for this comment")

            candidate = _strip_wrapping_quotes(
                "".join(b.text for b in response.content if b.type == "text")
            )
            ok, failure = validate(candidate)
            if ok:
                self._this_run.append(candidate)
                return candidate

            LOGGER.warning("Attempt %d rejected (%s): %r", attempt, failure, candidate[:120])

        raise ReplyGenerationError(f"No usable reply after {MAX_ATTEMPTS} attempts (last: {failure})")


def pause_seconds(low: float, high: float) -> float:
    """Randomized gap between replies inside a run."""
    if high < low:
        low, high = high, low
    return random.uniform(low, high)
