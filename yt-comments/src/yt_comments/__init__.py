"""YouTube comment auto-reply for Lifestyle Design Realty channels.

Runs on a GitHub Actions cron. Each pass:
  1. decrypts the SQLite state DB from the `state` branch (state-sync action)
  2. lists new comment threads per configured channel
  3. filters out emoji-only / spammy / link-bearing / stale / already-handled
  4. asks Claude for a short reply that references the actual comment
  5. posts it via comments.insert with snippet.parentId
  6. records it in `replied_comments` and appends to the weekly digest
"""

__all__ = ["config", "state", "oauth", "youtube", "filters", "replies", "digest", "main"]
