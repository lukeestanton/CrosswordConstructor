"""Application configuration.

All secrets and tunables come from the repo-root ``.env`` (gitignored). This is
the single source of truth for env wiring; nothing else reads ``os.environ``
directly.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Backend/app/config.py -> repo root is two parents up.
REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",  # .env also holds frontend/scraper keys we don't model here
    )

    # --- Database -----------------------------------------------------------
    # SQLite file owned by this Python layer. Default lives under Backend/data.
    database_url: str = Field(
        default=f"sqlite:///{BACKEND_ROOT / 'data' / 'crossword.db'}",
        validation_alias="DATABASE_URL",
    )

    # --- LLM features -------------------------------------------------------
    # Optional: every LLM call site must degrade gracefully when this is absent.
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")

    # --- Scraping / external (wired now, used in later slices) ---------------
    times_cookie: str | None = Field(default=None, validation_alias="TIMES_COOKIE")
    poll_archive_url: str | None = Field(default=None, validation_alias="POLL_ARCHIVE_URL")

    @property
    def llm_enabled(self) -> bool:
        """LLM features are only available when a key is configured."""
        return bool(self.anthropic_api_key)


settings = Settings()
