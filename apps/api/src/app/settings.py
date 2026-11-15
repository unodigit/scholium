"""Application settings loaded from environment variables."""

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _int(name: str, default: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass
class Settings:
    DATABASE_URL: str = field(default_factory=lambda: _env("DATABASE_URL", "sqlite:///./scholium.db"))
    CONTENT_DIR: str = field(default_factory=lambda: _env("CONTENT_DIR", "./data/content"))
    NODE_KEY_PATH: str = field(default_factory=lambda: _env("NODE_KEY_PATH", "./data/node.key"))
    JWT_SECRET: str = field(default_factory=lambda: _env("JWT_SECRET", "change-me-in-production"))
    COMMITTEE_PUBLIC_KEY: str = field(default_factory=lambda: _env("COMMITTEE_PUBLIC_KEY", ""))
    ORCID_BASE_URL: str = field(default_factory=lambda: _env("ORCID_BASE_URL", "https://orcid.org"))
    ORCID_CLIENT_ID: str = field(default_factory=lambda: _env("ORCID_CLIENT_ID", ""))
    ORCID_CLIENT_SECRET: str = field(default_factory=lambda: _env("ORCID_CLIENT_SECRET", ""))
    ORCID_MOCK: int = field(default_factory=lambda: _int("ORCID_MOCK", 1))
    ARXIV_MOCK: int = field(default_factory=lambda: _int("ARXIV_MOCK", 1))
    AI_PROVIDER: str = field(default_factory=lambda: _env("AI_PROVIDER", "fake"))
    AI_HOSTED_MODEL: str = field(default_factory=lambda: _env("AI_HOSTED_MODEL", "claude-sonnet-5-5"))
    OLLAMA_URL: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://localhost:11434"))
    SMTP_URL: str = field(default_factory=lambda: _env("SMTP_URL", ""))
    JOBS_EAGER: int = field(default_factory=lambda: _int("JOBS_EAGER", 1))
    NEXT_PUBLIC_API_URL: str = field(default_factory=lambda: _env("NEXT_PUBLIC_API_URL", "http://localhost:8000"))


settings = Settings()