"""OAuth2 for the YouTube Data API (scope: https://www.googleapis.com/auth/youtube.force-ssl).

Installed-app / refresh-token flow: the long-lived refresh token lives in a
GitHub secret and is exchanged for a short-lived access token at the start of
each run. Nothing is written to disk.
"""
from __future__ import annotations

import logging
import time

import requests

LOGGER = logging.getLogger("yt.oauth")

TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl"


class OAuthError(RuntimeError):
    pass


def fetch_access_token(
    client_id: str,
    client_secret: str,
    refresh_token: str,
    timeout: float = 30.0,
) -> tuple[str, float]:
    """Exchange the refresh token for an access token.

    Returns (access_token, expires_at_epoch_seconds).
    """
    if not (client_id and client_secret and refresh_token):
        raise OAuthError("YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REFRESH_TOKEN must all be set")

    response = requests.post(
        TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=timeout,
    )

    if response.status_code != 200:
        # Google returns {"error": "invalid_grant"} for a revoked or expired
        # refresh token — the one failure that needs a human, so name it.
        detail = response.text[:400]
        if "invalid_grant" in detail:
            raise OAuthError(
                "Google rejected the refresh token (invalid_grant). It was revoked, "
                "expired, or was issued for a different client. Re-run the OAuth "
                "consent flow and update the YT_REFRESH_TOKEN secret."
            )
        raise OAuthError(f"Token refresh failed ({response.status_code}): {detail}")

    payload = response.json()
    token = payload.get("access_token")
    if not token:
        raise OAuthError(f"Token refresh returned no access_token: {payload}")

    granted = payload.get("scope", "")
    if granted and SCOPE not in granted:
        # Not fatal — Google sometimes omits `scope` — but a token without
        # force-ssl cannot post comments, and the 403 it produces later is
        # much harder to read than this warning.
        LOGGER.warning(
            "Access token scopes (%s) do not include %s — comment posting will 403",
            granted,
            SCOPE,
        )

    expires_in = float(payload.get("expires_in", 3600))
    return token, time.time() + expires_in
