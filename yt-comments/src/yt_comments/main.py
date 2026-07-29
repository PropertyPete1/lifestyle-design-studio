"""One reply pass. Invoked by .github/workflows/yt-comments.yml."""
from __future__ import annotations

import logging
import sys
import time
from collections import Counter

from . import digest, filters, state
from .config import Settings, now_iso
from .oauth import OAuthError
from .replies import ReplyGenerationError, ReplyWriter, pause_seconds
from .youtube import CommentThread, YouTubeClient, YouTubeError

LOGGER = logging.getLogger("yt.main")

EXIT_OK = 0
EXIT_ERROR = 1


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )


def _interleave(by_channel: dict[str, list[CommentThread]]) -> list[tuple[str, CommentThread]]:
    """Round-robin channels, newest-first within each.

    Round-robin so one busy channel can't eat the whole per-run cap, and
    newest-first because comment engagement decays fast. If a channel ever
    backs up beyond the cap, fresh comments win and the stragglers age out —
    that is the intended tradeoff, not an oversight.
    """
    queues = {
        name: sorted(
            threads,
            key=lambda t: t.published_at.timestamp() if t.published_at else 0,
            reverse=True,
        )
        for name, threads in by_channel.items()
    }
    ordered: list[tuple[str, CommentThread]] = []
    while any(queues.values()):
        for name in list(queues):
            if queues[name]:
                ordered.append((name, queues[name].pop(0)))
    return ordered


def run() -> int:
    _configure_logging()
    started_at = now_iso()
    settings = Settings.load()

    mode = "DRY RUN" if settings.dry_run else "LIVE"
    LOGGER.info("=== YouTube comment auto-reply — %s ===", mode)

    # --- preflight: bail cleanly, not loudly, on an unconfigured install ---
    if not settings.has_youtube_credentials:
        LOGGER.warning(
            "YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN are not all set — "
            "nothing to do. Add them as repository secrets to enable this workflow."
        )
        return EXIT_OK

    if not settings.anthropic_api_key:
        LOGGER.warning("ANTHROPIC_API_KEY is not set — nothing to do.")
        return EXIT_OK

    channels = settings.active_channels
    if not channels:
        LOGGER.warning(
            "No real channel IDs in config/channels.yaml (all entries are still "
            "UC_REPLACE_WITH_... placeholders) — nothing to do."
        )
        return EXIT_OK

    conn = state.get_db(settings.db_path)
    replied = state.replied_ids(conn)
    LOGGER.info(
        "%d channel(s), %d comment(s) already replied to historically",
        len(channels),
        len(replied),
    )

    # --- daily quota guard -------------------------------------------------
    replies_today = state.replies_in_last_hours(conn, 24)
    remaining_today = max(0, settings.max_replies_per_day - replies_today)
    if remaining_today == 0:
        LOGGER.warning(
            "Daily cap reached (%d replies in the last 24h) — skipping this pass",
            replies_today,
        )
        state.record_run(
            conn,
            started_at,
            {"scanned": 0, "eligible": 0, "replied": 0, "skipped": 0, "failed": 0,
             "halted": "daily_cap", "dry_run": settings.dry_run},
        )
        return EXIT_OK

    cap = min(settings.max_replies_per_run, remaining_today)

    try:
        client = YouTubeClient(
            settings.client_id, settings.client_secret, settings.refresh_token
        )
        own_ids = set(client.own_channel_ids())
    except OAuthError as exc:
        LOGGER.error("OAuth failed: %s", exc)
        return EXIT_ERROR

    # A monitored channel is by definition ours, so its own id counts as self
    # even if channels.list(mine=true) came back empty.
    own_ids.update(c.id for c in channels)

    # --- scan ---------------------------------------------------------------
    scanned = 0
    skip_reasons: Counter[str] = Counter()
    eligible: dict[str, list[CommentThread]] = {}

    for channel in channels:
        try:
            threads = client.list_comment_threads(channel.id)
        except (YouTubeError, OAuthError) as exc:
            LOGGER.error("Could not list threads for %s (%s): %s", channel.name, channel.id, exc)
            skip_reasons["channel_list_failed"] += 1
            continue

        scanned += len(threads)
        keepers = []
        for thread in threads:
            verdict = filters.screen(
                thread,
                own_channel_ids=own_ids,
                replied=replied,
                max_age_days=settings.max_comment_age_days,
                skip_if_reply_count_at_least=settings.skip_if_reply_count_at_least,
            )
            if verdict.keep:
                keepers.append(thread)
            else:
                skip_reasons[verdict.reason] += 1

        if keepers:
            eligible[channel.name] = keepers
        LOGGER.info("%s: %d/%d eligible", channel.name, len(keepers), len(threads))

    eligible_count = sum(len(v) for v in eligible.values())
    if skip_reasons:
        LOGGER.info("Skips: %s", dict(skip_reasons.most_common()))

    queue = _interleave(eligible)[:cap]
    if len(queue) < eligible_count:
        LOGGER.info(
            "Capped at %d replies this run (%d eligible, %d left in the daily budget)",
            len(queue),
            eligible_count,
            remaining_today,
        )

    voice_by_channel = {c.name: c.voice for c in channels}
    titles = client.video_titles([t.video_id for _, t in queue]) if queue else {}

    # --- reply --------------------------------------------------------------
    writer = ReplyWriter(settings.anthropic_api_key, settings.llm_model)
    recent = state.recent_reply_texts(conn, 25)

    posted: list[digest.DigestEntry] = []
    failed = 0
    halted = ""

    for index, (channel_name, thread) in enumerate(queue):
        try:
            reply_text = writer.write(
                thread.text,
                author_name=thread.author_name,
                video_title=titles.get(thread.video_id, ""),
                voice=voice_by_channel.get(channel_name, ""),
                recent_replies=recent,
            )
        except ReplyGenerationError as exc:
            LOGGER.warning("No reply written for %s: %s", thread.comment_id, exc)
            failed += 1
            continue
        except Exception as exc:  # network/API trouble on the Anthropic side
            LOGGER.error("Reply generation error for %s: %s", thread.comment_id, exc)
            failed += 1
            continue

        LOGGER.info(
            "%s | %s: %r -> %r",
            channel_name,
            thread.author_name or "viewer",
            thread.text[:80],
            reply_text,
        )

        if settings.dry_run:
            posted.append(
                digest.DigestEntry(
                    channel_name, thread.video_id, titles.get(thread.video_id, ""),
                    thread.author_name, thread.text, reply_text,
                )
            )
            recent.insert(0, reply_text)
            continue

        try:
            client.post_reply(thread.comment_id, reply_text)
        except YouTubeError as exc:
            failed += 1
            message = str(exc)
            LOGGER.error("Posting failed for %s: %s", thread.comment_id, message)
            # Quota exhaustion won't fix itself inside this run — stop early so
            # the remaining candidates stay eligible for the next pass instead
            # of burning attempts.
            if "quotaExceeded" in message or "dailyLimitExceeded" in message:
                halted = "quota_exceeded"
                break
            continue
        except OAuthError as exc:
            LOGGER.error("Auth failed mid-run: %s", exc)
            halted = "auth_failed"
            break

        # Record immediately: a crash after this point must not re-reply.
        state.record_reply(conn, thread.comment_id, thread.video_id, thread.channel_id, reply_text)
        replied.add(thread.comment_id)
        recent.insert(0, reply_text)
        posted.append(
            digest.DigestEntry(
                channel_name, thread.video_id, titles.get(thread.video_id, ""),
                thread.author_name, thread.text, reply_text,
            )
        )

        if index < len(queue) - 1:
            gap = pause_seconds(
                settings.min_seconds_between_replies, settings.max_seconds_between_replies
            )
            LOGGER.info("Waiting %.1fs before the next reply", gap)
            time.sleep(gap)

    # --- bookkeeping --------------------------------------------------------
    stats = {
        "scanned": scanned,
        "eligible": eligible_count,
        "replied": len(posted),
        "skipped": sum(skip_reasons.values()),
        "failed": failed,
        "quota_used": client.quota_used,
        "dry_run": settings.dry_run,
        "skip_reasons": dict(skip_reasons.most_common(12)),
    }
    if halted:
        stats["halted"] = halted

    state.record_run(conn, started_at, stats)

    if posted:
        digest.append(settings.digest_path, posted, stats)

    LOGGER.info(
        "Done — scanned %d, eligible %d, %s %d, failed %d, quota %du%s",
        scanned,
        eligible_count,
        "would reply to" if settings.dry_run else "replied to",
        len(posted),
        failed,
        client.quota_used,
        f", halted: {halted}" if halted else "",
    )

    conn.close()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(run())
