"""Configuration: env vars + config/channels.yaml."""
from __future__ import annotations

import datetime as dt
import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

# Central Time — all timestamps in the DB and digest are CT, matching the rest
# of the LDR automation stack.
CT = dt.timezone(dt.timedelta(hours=-6))

REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "channels.yaml"
DEFAULT_DB_PATH = REPO_ROOT / "data" / "yt_comments.sqlite3"
DEFAULT_DIGEST_PATH = REPO_ROOT / "data" / "weekly_digest.md"

# Anthropic model for reply generation. Overridable so a model bump doesn't
# need a code change.
DEFAULT_LLM_MODEL = "claude-opus-5"


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Channel:
    """One monitored channel."""

    id: str
    name: str
    voice: str

    @property
    def is_placeholder(self) -> bool:
        """True for the shipped `UC_REPLACE_WITH_...` stubs."""
        return "REPLACE_WITH" in self.id


@dataclass
class Settings:
    channels: list[Channel] = field(default_factory=list)

    max_comment_age_days: int = 14
    max_replies_per_run: int = 20
    max_replies_per_day: int = 100
    min_seconds_between_replies: float = 3.0
    max_seconds_between_replies: float = 5.0
    skip_if_reply_count_at_least: int = 1

    db_path: Path = DEFAULT_DB_PATH
    digest_path: Path = DEFAULT_DIGEST_PATH

    client_id: str = ""
    client_secret: str = ""
    refresh_token: str = ""
    anthropic_api_key: str = ""
    llm_model: str = DEFAULT_LLM_MODEL

    dry_run: bool = False

    @property
    def has_youtube_credentials(self) -> bool:
        return bool(self.client_id and self.client_secret and self.refresh_token)

    @property
    def active_channels(self) -> list[Channel]:
        return [c for c in self.channels if not c.is_placeholder]

    @classmethod
    def load(cls, config_path: Path | str | None = None) -> "Settings":
        path = Path(config_path or os.environ.get("YT_CONFIG_PATH") or DEFAULT_CONFIG_PATH)
        raw = yaml.safe_load(path.read_text()) or {}

        defaults = raw.get("defaults") or {}
        house_voice = (defaults.get("voice") or "").strip()

        channels: list[Channel] = []
        for entry in raw.get("channels") or []:
            channel_id = str(entry.get("id") or "").strip()
            if not channel_id:
                continue
            channels.append(
                Channel(
                    id=channel_id,
                    name=str(entry.get("name") or channel_id).strip(),
                    voice=(entry.get("voice") or house_voice).strip(),
                )
            )

        return cls(
            channels=channels,
            max_comment_age_days=int(defaults.get("max_comment_age_days", 14)),
            max_replies_per_run=int(defaults.get("max_replies_per_run", 20)),
            max_replies_per_day=int(defaults.get("max_replies_per_day", 100)),
            min_seconds_between_replies=float(defaults.get("min_seconds_between_replies", 3)),
            max_seconds_between_replies=float(defaults.get("max_seconds_between_replies", 5)),
            skip_if_reply_count_at_least=int(defaults.get("skip_if_reply_count_at_least", 1)),
            db_path=Path(os.environ.get("YT_DATABASE_PATH") or DEFAULT_DB_PATH),
            digest_path=Path(os.environ.get("YT_DIGEST_PATH") or DEFAULT_DIGEST_PATH),
            client_id=os.environ.get("YT_CLIENT_ID", ""),
            client_secret=os.environ.get("YT_CLIENT_SECRET", ""),
            refresh_token=os.environ.get("YT_REFRESH_TOKEN", ""),
            anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            llm_model=os.environ.get("YT_LLM_MODEL") or DEFAULT_LLM_MODEL,
            dry_run=_env_flag("DRY_RUN", False),
        )


def now_ct() -> dt.datetime:
    return dt.datetime.now(CT)


def now_iso() -> str:
    return now_ct().isoformat(timespec="seconds")
