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
    # dev | production. Production refuses insecure defaults (see validate_for_environment).
    SCHOLIUM_ENV: str = field(default_factory=lambda: _env("SCHOLIUM_ENV", "dev"))
    # Comma-separated browser origins allowed to call the API (CORS).
    WEB_ORIGINS: str = field(default_factory=lambda: _env("WEB_ORIGINS", "http://localhost:3000"))
    # Per-tier write throttling (app.middleware). Tests disable it on the shared app.
    RATE_LIMIT_ENABLED: int = field(default_factory=lambda: _int("RATE_LIMIT_ENABLED", 1))

    @property
    def web_origins(self) -> list[str]:
        return [o.strip() for o in self.WEB_ORIGINS.split(",") if o.strip()]

    def validate_for_environment(self) -> None:
        """Refuse to run production with development-only defaults."""
        if self.SCHOLIUM_ENV != "production":
            return
        problems = []
        if self.JWT_SECRET in ("", "change-me-in-production") or len(self.JWT_SECRET) < 32:
            problems.append("JWT_SECRET must be set to a random value of at least 32 characters")
        if self.ORCID_MOCK:
            problems.append("ORCID_MOCK must be 0")
        if self.ARXIV_MOCK:
            problems.append("ARXIV_MOCK must be 0")
        if self.AI_PROVIDER == "fake":
            problems.append("AI_PROVIDER must not be fake")
        if "*" in self.web_origins:
            problems.append("WEB_ORIGINS must list explicit origins")
        if problems:
            raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))


settings = Settings()