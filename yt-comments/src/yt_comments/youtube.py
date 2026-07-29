"""YouTube Data API v3 client — comment threads in, replies out."""
from __future__ import annotations

import datetime as dt
import logging
import time
from dataclasses import dataclass, field

import requests

from .oauth import fetch_access_token

LOGGER = logging.getLogger("yt.api")

API_BASE = "https://www.googleapis.com/youtube/v3"

# commentThreads.list costs 1 quota unit; comments.insert costs 50.
QUOTA_LIST = 1
QUOTA_INSERT = 50


class YouTubeError(RuntimeError):
    """Non-retryable API failure."""


@dataclass
class CommentThread:
    """A top-level comment plus the bits of its thread we care about."""

    thread_id: str
    comment_id: str          # top-level comment id — this becomes snippet.parentId
    video_id: str
    channel_id: str          # the channel the thread belongs to (our channel)
    text: str
    author_name: str
    author_channel_id: str
    published_at: dt.datetime | None
    total_reply_count: int
    can_reply: bool
    reply_author_channel_ids: list[str] = field(default_factory=list)

    @property
    def age_days(self) -> float | None:
        if self.published_at is None:
            return None
        return (dt.datetime.now(dt.timezone.utc) - self.published_at).total_seconds() / 86400.0


def _parse_ts(raw: str | None) -> dt.datetime | None:
    if not raw:
        return None
    try:
        # YouTube returns RFC3339 with a trailing Z.
        return dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        LOGGER.warning("Unparseable publishedAt: %r", raw)
        return None


class YouTubeClient:
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        timeout: float = 30.0,
    ) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._refresh_token = refresh_token
        self._timeout = timeout
        self._token: str | None = None
        self._token_expires_at = 0.0
        self.quota_used = 0

    # -- auth ---------------------------------------------------------------

    def _access_token(self) -> str:
        # Refresh 60s early so a long run can't post with a just-expired token.
        if self._token is None or time.time() >= self._token_expires_at - 60:
            self._token, self._token_expires_at = fetch_access_token(
                self._client_id, self._client_secret, self._refresh_token, self._timeout
            )
            LOGGER.info("Access token refreshed")
        return self._token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._access_token()}",
            "Accept": "application/json",
        }

    # -- requests -----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json_body: dict | None = None,
        quota_cost: int = 1,
        retries: int = 2,
    ) -> dict:
        url = f"{API_BASE}/{path.lstrip('/')}"
        last_error = ""

        for attempt in range(retries + 1):
            response = requests.request(
                method,
                url,
                headers=self._headers(),
                params=params,
                json=json_body,
                timeout=self._timeout,
            )
            self.quota_used += quota_cost

            if response.status_code < 300:
                return response.json() if response.content else {}

            last_error = f"{response.status_code}: {response.text[:400]}"

            # 401 once means the token went stale mid-run; drop it and retry.
            if response.status_code == 401 and attempt < retries:
                LOGGER.warning("401 from %s — forcing token refresh", path)
                self._token = None
                continue

            # 5xx and rate-limit 403s are worth a backoff; everything else is
            # a real error (bad channel id, disabled comments, missing scope).
            transient = response.status_code >= 500 or (
                response.status_code == 403
                and ("rateLimitExceeded" in response.text or "backendError" in response.text)
            )
            if transient and attempt < retries:
                sleep_for = 2 ** attempt
                LOGGER.warning("Transient %s from %s — retrying in %ss", last_error, path, sleep_for)
                time.sleep(sleep_for)
                continue

            break

        raise YouTubeError(f"{method} {path} failed — {last_error}")

    # -- reads --------------------------------------------------------------

    def own_channel_ids(self) -> list[str]:
        """Channel IDs belonging to the authenticated account.

        Used to make sure the bot never replies to its own comments (which
        would otherwise loop: our reply is a comment, it gets listed next run).
        """
        try:
            payload = self._request(
                "GET", "channels", params={"part": "id", "mine": "true"}, quota_cost=QUOTA_LIST
            )
        except YouTubeError as exc:
            LOGGER.warning("Could not resolve own channel ids: %s", exc)
            return []
        return [item["id"] for item in payload.get("items", []) if item.get("id")]

    def list_comment_threads(
        self,
        channel_id: str,
        *,
        max_pages: int = 3,
        page_size: int = 100,
    ) -> list[CommentThread]:
        """All recent threads related to a channel, newest first.

        `allThreadsRelatedToChannelId` covers comments on every video on the
        channel plus comments on the channel itself, in one call — cheaper than
        walking videos. `part=snippet,replies` brings back up to 5 inline
        replies, which is what lets us spot a thread we (or a human) already
        answered without paying for a second request.
        """
        threads: list[CommentThread] = []
        page_token: str | None = None

        for _ in range(max_pages):
            params = {
                "part": "snippet,replies",
                "allThreadsRelatedToChannelId": channel_id,
                "maxResults": page_size,
                "order": "time",
                "textFormat": "plainText",
            }
            if page_token:
                params["pageToken"] = page_token

            payload = self._request(
                "GET", "commentThreads", params=params, quota_cost=QUOTA_LIST
            )

            for item in payload.get("items", []):
                thread = self._parse_thread(item, channel_id)
                if thread is not None:
                    threads.append(thread)

            page_token = payload.get("nextPageToken")
            if not page_token:
                break

        LOGGER.info("channel %s: %d threads listed", channel_id, len(threads))
        return threads

    @staticmethod
    def _parse_thread(item: dict, channel_id: str) -> CommentThread | None:
        thread_snippet = item.get("snippet") or {}
        top = thread_snippet.get("topLevelComment") or {}
        snippet = top.get("snippet") or {}

        comment_id = top.get("id")
        if not comment_id:
            return None

        reply_authors = [
            ((r.get("snippet") or {}).get("authorChannelId") or {}).get("value", "")
            for r in ((item.get("replies") or {}).get("comments") or [])
        ]

        return CommentThread(
            thread_id=item.get("id", comment_id),
            comment_id=comment_id,
            video_id=thread_snippet.get("videoId") or snippet.get("videoId") or "",
            channel_id=channel_id,
            text=(snippet.get("textOriginal") or snippet.get("textDisplay") or "").strip(),
            author_name=snippet.get("authorDisplayName") or "",
            author_channel_id=(snippet.get("authorChannelId") or {}).get("value", ""),
            published_at=_parse_ts(snippet.get("publishedAt")),
            total_reply_count=int(thread_snippet.get("totalReplyCount") or 0),
            can_reply=bool(thread_snippet.get("canReply", True)),
            reply_author_channel_ids=[a for a in reply_authors if a],
        )

    def video_titles(self, video_ids: list[str]) -> dict[str, str]:
        """Title per video id, batched 50 at a time — context for the reply."""
        titles: dict[str, str] = {}
        unique = [v for v in dict.fromkeys(video_ids) if v]

        for start in range(0, len(unique), 50):
            batch = unique[start : start + 50]
            try:
                payload = self._request(
                    "GET",
                    "videos",
                    params={"part": "snippet", "id": ",".join(batch)},
                    quota_cost=QUOTA_LIST,
                )
            except YouTubeError as exc:
                # Titles are a nice-to-have; a failure here must not kill the run.
                LOGGER.warning("Could not fetch video titles: %s", exc)
                continue
            for item in payload.get("items", []):
                titles[item["id"]] = (item.get("snippet") or {}).get("title", "")

        return titles

    # -- writes -------------------------------------------------------------

    def post_reply(self, parent_comment_id: str, text: str) -> str:
        """comments.insert with snippet.parentId. Returns the new comment id."""
        payload = self._request(
            "POST",
            "comments",
            params={"part": "snippet"},
            json_body={"snippet": {"parentId": parent_comment_id, "textOriginal": text}},
            quota_cost=QUOTA_INSERT,
            retries=1,
        )
        return payload.get("id", "")
