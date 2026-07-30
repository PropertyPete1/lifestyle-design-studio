#!/usr/bin/env python3
"""Read-only credential check. Run this before trusting the workflow.

Exercises exactly what a scan pass does — token refresh, channels.list,
commentThreads.list — and stops short of posting anything. Prints no secrets,
so the output is safe to paste into a chat or an issue.

    export YT_CLIENT_ID=... YT_CLIENT_SECRET=... YT_REFRESH_TOKEN=...
    python3 verify_credentials.py                 # checks channels in config
    python3 verify_credentials.py UCxxxx          # or an explicit channel id
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

import requests  # noqa: E402

from yt_comments.config import Settings  # noqa: E402
from yt_comments.oauth import SCOPE, OAuthError, fetch_access_token  # noqa: E402
from yt_comments.youtube import YouTubeClient, YouTubeError  # noqa: E402

RULE = "=" * 64


def main() -> int:
    settings = Settings.load()

    if not settings.has_youtube_credentials:
        print("YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN must all be set.")
        return 1

    print(RULE)
    print("1. TOKEN REFRESH")
    print(RULE)
    try:
        token, _ = fetch_access_token(
            settings.client_id, settings.client_secret, settings.refresh_token
        )
        print("   OK — refresh token accepted, access token issued")
    except OAuthError as exc:
        print("   FAILED\n")
        print("  ", exc)
        print()
        print("   invalid_client + 'client secret is invalid' -> the client ID exists")
        print("   but the secret does not match it. Regenerate/copy the secret for this")
        print("   exact client in Google Cloud Console -> APIs & Services -> Credentials.")
        print("   invalid_client + 'OAuth client was not found' -> wrong client ID, or")
        print("   the client was deleted, or it lives in a different GCP project.")
        print("   invalid_grant -> secret is fine, the refresh token is revoked/expired")
        print("   or was issued by a different client. Re-run the consent flow.")
        return 1

    info = requests.get(
        "https://oauth2.googleapis.com/tokeninfo",
        params={"access_token": token},
        timeout=30,
    ).json()
    scopes = (info.get("scope") or "").split()
    print("   expires_in:", info.get("expires_in"), "seconds")
    print("   scopes:")
    for scope in scopes or ["(none reported)"]:
        print("     -", scope)

    can_post = SCOPE in scopes
    print()
    print(f"   youtube.force-ssl (required to post replies): "
          f"{'YES' if can_post else 'NO — comments.insert will 403'}")
    if not can_post:
        print("   Re-run the consent flow requesting that scope; a token with only")
        print("   drive/gmail/youtube.readonly scopes can read but never reply.")

    client = YouTubeClient(
        settings.client_id, settings.client_secret, settings.refresh_token
    )

    print()
    print(RULE)
    print("2. CHANNEL IDENTITY  (channels.list mine=true)")
    print(RULE)
    owned: list[str] = []
    try:
        payload = client._request(
            "GET", "channels", params={"part": "id,snippet,statistics", "mine": "true"}
        )
        items = payload.get("items", [])
        if not items:
            print("   This Google account owns no YouTube channel.")
        for item in items:
            snippet = item.get("snippet", {})
            stats = item.get("statistics", {})
            owned.append(item.get("id", ""))
            print("   id:     ", item.get("id"))
            print("   title:  ", snippet.get("title"))
            print("   handle: ", snippet.get("customUrl"))
            print("   videos: ", stats.get("videoCount"), " subs:", stats.get("subscriberCount"))
    except YouTubeError as exc:
        print("   FAILED:", exc)

    targets = sys.argv[1:] or [c.id for c in settings.active_channels]
    if not targets:
        print()
        print("   No channel IDs to scan — config/channels.yaml still holds placeholders.")
        print("   Pass one on the command line to test:  python3 verify_credentials.py UCxxxx")
        return 0

    print()
    print(RULE)
    print("3. COMMENT SCAN  (the exact call a run makes)")
    print(RULE)
    for channel_id in targets:
        flag = "" if channel_id in owned else "   [not owned by this account]"
        print(f"\n   channel {channel_id}{flag}")
        try:
            threads = client.list_comment_threads(channel_id, max_pages=1, page_size=25)
        except YouTubeError as exc:
            print("   FAILED:", exc)
            continue
        print(f"   {len(threads)} thread(s) returned")
        for thread in threads[:8]:
            age = thread.age_days
            print(f"     - {thread.author_name}: {thread.text[:64]!r}")
            print(f"       video={thread.video_id} age={age:.1f}d "
                  f"replies={thread.total_reply_count}")

    print()
    print(RULE)
    print(f"quota consumed: {client.quota_used} units (read-only — nothing was posted)")
    print(RULE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
