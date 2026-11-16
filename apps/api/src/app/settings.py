"""Application settings loaded from environment variables."""

import hashlib
import os
from dataclasses import dataclass, field
from urllib.parse import urlparse

_DEFAULT_JWT_SECRET = "change-me-in-production"
#: Domain separator for the deterministic development-only review key, so it
#: can never equal (or be confused with) ``JWT_SECRET`` itself.
_REVIEW_UNIQUENESS_KEY_LABEL = b"scholium:review-uniqueness:dev-key:v1:"

#: Hosts that only ever make sense on a developer machine.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}

#: Hosted AI providers and the environment variable holding their API key.
_HOSTED_AI_KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY"}


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _derive_review_uniqueness_key(jwt_secret: str) -> str:
    """Deterministic dev/test ``REVIEW_UNIQUENESS_KEY``, distinct from ``JWT_SECRET``."""
    return hashlib.sha256(
        _REVIEW_UNIQUENESS_KEY_LABEL + (jwt_secret or "").encode("utf-8")
    ).hexdigest()


def _is_loopback_url(url: str) -> bool:
    """True when ``url`` points at the local machine (``localhost``/loopback)."""
    host = (urlparse((url or "").strip()).hostname or "").lower()
    return host in _LOOPBACK_HOSTS or host.endswith(".localhost")


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
    JWT_SECRET: str = field(default_factory=lambda: _env("JWT_SECRET", _DEFAULT_JWT_SECRET))
    # Key for the one-review-per-person uniqueness HMAC.  In dev/test it is
    # derived deterministically (but domain-separated) from JWT_SECRET so the
    # suite works with no extra env; production must configure its own key.
    REVIEW_UNIQUENESS_KEY: str = field(
        default_factory=lambda: _env("REVIEW_UNIQUENESS_KEY", "").strip()
        or _derive_review_uniqueness_key(_env("JWT_SECRET", _DEFAULT_JWT_SECRET))
    )
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
        if self.JWT_SECRET in ("", _DEFAULT_JWT_SECRET) or len(self.JWT_SECRET) < 32:
            problems.append("JWT_SECRET must be set to a random value of at least 32 characters")
        review_key = (self.REVIEW_UNIQUENESS_KEY or "").strip()
        if len(review_key) < 32 or review_key in {
            _derive_review_uniqueness_key(_DEFAULT_JWT_SECRET),
            _derive_review_uniqueness_key(self.JWT_SECRET),
        }:
            problems.append(
                "REVIEW_UNIQUENESS_KEY must be set to a random value of at least 32 characters"
            )
        if not (self.COMMITTEE_PUBLIC_KEY or "").strip():
            problems.append("COMMITTEE_PUBLIC_KEY must be set for review escrow")
        if not (self.SMTP_URL or "").strip():
            problems.append("SMTP_URL must be set so verification and notification emails are delivered")
        node_key_path = (self.NODE_KEY_PATH or "").strip()
        if not node_key_path or not os.path.isfile(node_key_path):
            problems.append(
                f"NODE_KEY_PATH must point at an existing node key file (got {node_key_path!r})"
            )
        if not (self.ORCID_CLIENT_ID or "").strip() or not (self.ORCID_CLIENT_SECRET or "").strip():
            problems.append("ORCID_CLIENT_ID and ORCID_CLIENT_SECRET must be set")
        if self.ORCID_MOCK:
            problems.append("ORCID_MOCK must be 0")
        if self.ARXIV_MOCK:
            problems.append("ARXIV_MOCK must be 0")
        if self.JOBS_EAGER:
            problems.append("JOBS_EAGER must be 0 (jobs run on the background worker)")
        provider = (self.AI_PROVIDER or "").strip().lower()
        if provider == "fake":
            problems.append("AI_PROVIDER must not be fake")
        key_env = _HOSTED_AI_KEY_ENV.get(provider)
        if key_env and not _env(key_env, "").strip():
            problems.append(f"{key_env} must be set when AI_PROVIDER is {provider}")
        if "*" in self.web_origins:
            problems.append("WEB_ORIGINS must list explicit origins")
        elif any(_is_loopback_url(origin) for origin in self.web_origins):
            problems.append("WEB_ORIGINS must not point at localhost in production")
        if _is_loopback_url(self.NEXT_PUBLIC_API_URL):
            problems.append("NEXT_PUBLIC_API_URL must not point at localhost in production")
        if problems:
            raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))


settings = Settings()