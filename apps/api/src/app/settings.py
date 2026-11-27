"""Application settings loaded from environment variables."""

import atexit
import base64
import binascii
import hashlib
import logging
import os
import shutil
import stat
import tempfile
import threading
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_DEFAULT_JWT_SECRET = "change-me-in-production"
#: Domain separator for the deterministic development-only review key, so it
#: can never equal (or be confused with) ``JWT_SECRET`` itself.
_REVIEW_UNIQUENESS_KEY_LABEL = b"scholium:review-uniqueness:dev-key:v1:"

#: Hosts that only ever make sense on a developer machine.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}

#: Hosted AI providers whose API key is read from the environment by their SDK.
#: ``openai`` is checked by :meth:`Settings._openai_problems` instead.
_HOSTED_AI_KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY"}

#: Accepted values of ``AI_PROVIDER`` (see ``app.modules.ai_review.providers``).
#: The ids name protocols, not vendors.
_AI_PROVIDERS = ("fake", "anthropic", "openai", "ollama")

#: ``OPENAI_BASE_URL`` when it is unset or blank: the OpenAI API itself.
_DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"

#: Accepted spellings of ``SCHOLIUM_ENV``, mapped to their canonical value.
#: Anything else is unknown and is refused by
#: :meth:`Settings.validate_for_environment` rather than starting the app.
_ENV_ALIASES = {"dev": "dev", "prod": "production", "production": "production"}

#: Accepted spellings of ``SANDBOX_BACKEND``.  Kept here rather than imported
#: from the sandbox module so production validation never has to import it.
_SANDBOX_BACKENDS = ("docker", "podman", "remote", "none")

#: Accepted values of ``JOBS_MODE`` (see :attr:`Settings.jobs_mode`).
_JOBS_MODES = ("eager", "thread", "external")

#: Accepted values of ``STORAGE_BACKEND``: ``fs`` keeps objects under
#: ``CONTENT_DIR``, ``s3`` keeps them in an S3-API bucket (see ``app.storage``).
_STORAGE_BACKENDS = ("fs", "s3")

#: URL schemes production accepts for ``DATABASE_URL``.  ``postgres://`` is the
#: Heroku spelling and ``postgresql+psycopg://`` names the driver explicitly;
#: both are served by psycopg (v3).  Every other scheme -- SQLite above all --
#: is refused in production (see :meth:`Settings.validate_for_environment`).
_POSTGRES_SCHEMES = ("postgres", "postgresql", "postgresql+psycopg")


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _base_url(name: str, default: str) -> str:
    """A base URL from the environment without whitespace or trailing slashes.

    Unset, blank or only slashes give ``default``, so ``OPENAI_BASE_URL=`` in a
    compose file or ``.env`` behaves like not setting it.
    """
    return _env(name, default).strip().rstrip("/") or default


def _normalise_environment(value: str) -> str:
    """Canonical ``SCHOLIUM_ENV`` value (unknown values are kept, then refused)."""
    key = (value or "").strip().lower()
    return _ENV_ALIASES.get(key, key)


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


def _flag(name: str, default: int = 0) -> int:
    """A yes/no environment variable as ``0``/``1``.

    Accepts ``1``/``0`` like :func:`_int` and also ``true``/``false``,
    ``yes``/``no`` and ``on``/``off`` (any case), so a flag written the way a
    compose file or a shell user would write it is not silently read as off.
    Anything else keeps the default.
    """
    raw = (os.getenv(name) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return 1
    if raw in ("0", "false", "no", "off"):
        return 0
    return default


# ---------------------------------------------------------------------------
# NODE_KEY: the node signing key supplied through the environment.
#
# Every reader of the node key (ledger origin/sync head, signing of renditions,
# imports, ORCID credentials, ...) takes a *file* at ``settings.NODE_KEY_PATH``.
# So an environment-supplied key is written to an owner-only file in a private
# directory and ``NODE_KEY_PATH`` is pointed at it; no reader needs to change.
# The value itself is never logged, never put in an error message and is kept
# out of ``repr(settings)``.
# ---------------------------------------------------------------------------

_NODE_KEY_FILE_MODE = 0o600

_node_key_lock = threading.Lock()
#: The per-process private directory holding the written key files, and the pid
#: that created it (only that process removes it at exit).
_node_key_dir: Optional[str] = None
_node_key_dir_pid: Optional[int] = None
#: sha256 of a NODE_KEY value -> the file it was written to, so constructing
#: several ``Settings`` in one process reuses one file per distinct key.
_node_key_files: dict[bytes, str] = {}


def _decode_node_key(value: str) -> Optional[bytes]:
    """The 32-byte Ed25519 seed encoded by a ``NODE_KEY`` value, or ``None``.

    Accepts the key-file formats that can travel in an environment variable: a
    32-byte seed or a 64-byte libsodium secret key (seed || public key),
    encoded as hex or base64 text.  Hex is tried first, as in
    :func:`app.modules.ledger.origin.node_signing_key`, so both decode a value
    the same way.  Unlike the key *file* loader, text that is neither hex nor
    base64 is never reinterpreted as a raw key: an arbitrary 32-character
    string must not silently become a signing key.
    """
    text = (value or "").strip()
    if not text:
        return None
    try:
        text.encode("ascii")
    except UnicodeEncodeError:
        return None
    candidates: list[bytes] = []
    try:
        candidates.append(bytes.fromhex(text))
    except ValueError:
        pass
    try:
        candidates.append(base64.b64decode(text, validate=True))
    except (binascii.Error, ValueError):
        pass
    for candidate in candidates:
        if len(candidate) in (32, 64):
            return candidate[:32]
    return None


def _usable_runtime_base() -> Optional[str]:
    """``$XDG_RUNTIME_DIR`` when it is a directory only this user can use."""
    base = os.environ.get("XDG_RUNTIME_DIR", "")
    if not base or not os.path.isabs(base):
        return None
    try:
        info = os.stat(base)
    except OSError:
        return None
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.geteuid()
        or info.st_mode & 0o077
        or not os.access(base, os.W_OK | os.X_OK)
    ):
        return None
    return base


def _remove_node_key_dir(path: str, pid: int) -> None:
    if os.getpid() == pid:  # a forked child must not delete its parent's key
        shutil.rmtree(path, ignore_errors=True)


def _private_runtime_dir() -> str:
    """The private (mode 0700, owner-only) directory the key file goes in.

    Created on first use under ``$XDG_RUNTIME_DIR`` (a per-user tmpfs on most
    Linux hosts) when that is usable, otherwise under the system temp dir.
    ``mkdtemp`` gives it an unpredictable name and mode 0700 whatever the
    umask.  It is removed when the process exits.  Callers hold
    ``_node_key_lock``.
    """
    global _node_key_dir, _node_key_dir_pid
    if _node_key_dir is not None and os.path.isdir(_node_key_dir):
        return _node_key_dir
    _node_key_files.clear()
    directory = tempfile.mkdtemp(prefix="scholium-node-key-", dir=_usable_runtime_base())
    os.chmod(directory, 0o700)
    _node_key_dir, _node_key_dir_pid = directory, os.getpid()
    atexit.register(_remove_node_key_dir, directory, os.getpid())
    return directory


def _write_node_key_file(value: str) -> str:
    """Write ``value`` to an owner-only file in the private runtime dir; return its path."""
    text = value.strip()
    fingerprint = hashlib.sha256(text.encode("utf-8")).digest()
    with _node_key_lock:
        existing = _node_key_files.get(fingerprint)
        if existing and os.path.isfile(existing):
            return existing
        directory = _private_runtime_dir()
        # mkstemp creates the file O_EXCL and no wider than 0600 (the umask can
        # only narrow it); the chmod pins it at exactly 0600.
        fd, path = tempfile.mkstemp(prefix="node-", suffix=".key", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
            os.chmod(path, _NODE_KEY_FILE_MODE)
        except BaseException:
            try:
                os.unlink(path)
            except OSError:
                pass
            raise
        _node_key_files[fingerprint] = path
        return path


@dataclass
class Settings:
    # A SQLite path by default; ``postgres://`` and ``postgresql://`` URLs are
    # served through the psycopg (v3) driver (see ``app.db``).
    DATABASE_URL: str = field(default_factory=lambda: _env("DATABASE_URL", "sqlite:///./scholium.db"))
    # PostgreSQL connection pool (ignored for SQLite, which keeps SQLAlchemy's
    # default engine options).  The defaults match SQLAlchemy's own.
    DB_POOL_SIZE: int = field(default_factory=lambda: _int("DB_POOL_SIZE", 5))
    DB_MAX_OVERFLOW: int = field(default_factory=lambda: _int("DB_MAX_OVERFLOW", 10))
    CONTENT_DIR: str = field(default_factory=lambda: _env("CONTENT_DIR", "./data/content"))
    # Where objects (content blobs, staged uploads) live: ``fs`` (the default)
    # writes under CONTENT_DIR; ``s3`` writes to S3_BUCKET through the S3 API,
    # at S3_ENDPOINT_URL when set (MinIO, R2, ...) or the provider default when
    # not.  S3_REGION may stay empty for providers that ignore it.  Blank
    # S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY fall back to the S3 client's own
    # credential lookup outside production.  S3_FORCE_PATH_STYLE=1 addresses the
    # bucket as ``endpoint/bucket`` rather than ``bucket.endpoint`` (needed by
    # most self-hosted servers).  See ``app.storage``.
    STORAGE_BACKEND: str = field(
        default_factory=lambda: (_env("STORAGE_BACKEND", "fs") or "fs").strip().lower()
    )
    S3_BUCKET: str = field(default_factory=lambda: _env("S3_BUCKET", "").strip())
    S3_ENDPOINT_URL: str = field(default_factory=lambda: _env("S3_ENDPOINT_URL", "").strip())
    S3_REGION: str = field(default_factory=lambda: _env("S3_REGION", "").strip())
    S3_ACCESS_KEY_ID: str = field(default_factory=lambda: _env("S3_ACCESS_KEY_ID", "").strip())
    # Secret: excluded from repr() so it cannot reach logs or tracebacks.
    S3_SECRET_ACCESS_KEY: str = field(
        default_factory=lambda: _env("S3_SECRET_ACCESS_KEY", "").strip(), repr=False
    )
    S3_FORCE_PATH_STYLE: int = field(default_factory=lambda: _flag("S3_FORCE_PATH_STYLE", 0))
    NODE_KEY_PATH: str = field(default_factory=lambda: _env("NODE_KEY_PATH", "./data/node.key"))
    # The node signing key itself (hex or base64, same formats as the key
    # file), as an alternative to a key file.  When set it takes precedence over
    # NODE_KEY_PATH: it is written to an owner-only file in a private runtime
    # directory and NODE_KEY_PATH is pointed at that file.  Secret: excluded
    # from repr() so it cannot reach logs or tracebacks.
    NODE_KEY: str = field(default_factory=lambda: _env("NODE_KEY", ""), repr=False)
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
    # fake | anthropic | openai | ollama, in any case and with surrounding
    # spaces ignored (as ``get_provider`` reads it).  Anything else is refused by
    # validate_for_environment in every environment.  ``openai`` names the
    # OpenAI-compatible chat-completions protocol, not a vendor: point
    # OPENAI_BASE_URL at any server that speaks it.
    AI_PROVIDER: str = field(default_factory=lambda: _env("AI_PROVIDER", "fake"))
    # The hosted model id.  The default is an Anthropic model, so production
    # refuses AI_PROVIDER=openai unless the variable is set explicitly.
    AI_HOSTED_MODEL: str = field(default_factory=lambda: _env("AI_HOSTED_MODEL", "claude-sonnet-5-5"))
    # Where the Anthropic provider sends requests; empty means the Anthropic SDK
    # default.
    ANTHROPIC_BASE_URL: str = field(default_factory=lambda: _env("ANTHROPIC_BASE_URL", "").strip())
    # OpenAI-compatible provider: the API key (empty when unset) and the base URL
    # the ``/chat/completions`` path is appended to.  Secret: the key is excluded
    # from repr() so it cannot reach logs or tracebacks.
    OPENAI_API_KEY: str = field(
        default_factory=lambda: _env("OPENAI_API_KEY", "").strip(), repr=False
    )
    OPENAI_BASE_URL: str = field(
        default_factory=lambda: _base_url("OPENAI_BASE_URL", _DEFAULT_OPENAI_BASE_URL)
    )
    OLLAMA_URL: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://localhost:11434"))
    SMTP_URL: str = field(default_factory=lambda: _env("SMTP_URL", ""))
    EMAIL_SIGNIN_KEY: str = field(default_factory=lambda: _env("EMAIL_SIGNIN_KEY", "").strip(), repr=False)
    BREVO_SMTP_PORT: int = field(default_factory=lambda: _int("BREVO_SMTP_PORT", 0))
    BREVO_API_KEY: str = field(default_factory=lambda: _env("BREVO_API_KEY", "").strip(), repr=False)
    RESEND_API_KEY: str = field(default_factory=lambda: _env("RESEND_API_KEY", "").strip(), repr=False)
    SMTP_FROM: str = field(default_factory=lambda: _env("SMTP_FROM", "").strip())
    JOBS_EAGER: int = field(default_factory=lambda: _int("JOBS_EAGER", 1))
    # JOBS_MODE picks how queued jobs get run: ``eager`` runs them inline on the
    # caller, ``thread`` on the API's own in-process worker, ``external`` not at
    # all -- the API only writes queued rows for a separate worker process.
    # Unset, the mode follows JOBS_EAGER (see ``jobs_mode``), so eager stays the
    # default and the older JOBS_EAGER=0 still means "thread".
    JOBS_MODE: str = field(default_factory=lambda: _env("JOBS_MODE", "").strip().lower())
    # The reproducibility sandbox's runner: docker (default), podman, remote or
    # none.  "remote" posts the bundle cid and limits to SANDBOX_URL with the
    # bearer token SANDBOX_TOKEN (at least 32 characters in production); "none"
    # never runs code.  See app.modules.ai_review.sandbox.
    SANDBOX_BACKEND: str = field(
        default_factory=lambda: (_env("SANDBOX_BACKEND", "docker") or "docker").strip().lower()
    )
    SANDBOX_URL: str = field(default_factory=lambda: _env("SANDBOX_URL", "").strip())
    # Secret: excluded from repr() so it cannot reach logs or tracebacks.
    SANDBOX_TOKEN: str = field(
        default_factory=lambda: _env("SANDBOX_TOKEN", "").strip(), repr=False
    )
    NEXT_PUBLIC_API_URL: str = field(default_factory=lambda: _env("NEXT_PUBLIC_API_URL", "http://localhost:8000"))
    # dev | production (case-insensitive; "prod" is an alias for "production").
    # Production refuses insecure defaults (see validate_for_environment).
    SCHOLIUM_ENV: str = field(
        default_factory=lambda: _normalise_environment(_env("SCHOLIUM_ENV", "dev"))
    )
    # Comma-separated browser origins allowed to call the API (CORS).
    WEB_ORIGINS: str = field(default_factory=lambda: _env("WEB_ORIGINS", "http://localhost:3000"))
    # Per-tier write throttling (app.middleware). Tests disable it on the shared app.
    RATE_LIMIT_ENABLED: int = field(default_factory=lambda: _int("RATE_LIMIT_ENABLED", 1))

    def __post_init__(self) -> None:
        if not (self.NODE_KEY or "").strip():
            return
        if _env("NODE_KEY_PATH").strip():
            logger.info("NODE_KEY and NODE_KEY_PATH are both set; NODE_KEY takes precedence")
        try:
            applied = self.apply_node_key()
        except OSError as exc:
            # Never fatal here (production validation re-checks and refuses),
            # and never with the value: only the OS error is reported.
            logger.error(
                "NODE_KEY could not be written to a private key file (%s); "
                "NODE_KEY_PATH is unchanged",
                exc.strerror or type(exc).__name__,
            )
            return
        if not applied:
            logger.warning(
                "NODE_KEY is set but is not a valid Ed25519 key (32 or 64 bytes as hex or "
                "base64); ignoring it and keeping NODE_KEY_PATH"
            )

    def apply_node_key(self) -> bool:
        """Provision ``NODE_KEY`` as a key file and point ``NODE_KEY_PATH`` at it.

        Returns ``True`` once ``NODE_KEY_PATH`` names an owner-only (0600) file
        holding the key.  Returns ``False`` -- writing nothing and leaving
        ``NODE_KEY_PATH`` alone -- when ``NODE_KEY`` is unset or does not decode
        to an Ed25519 key.  Idempotent: the same key reuses its file.  Raises
        ``OSError`` when the file cannot be written; the error never contains
        the key.
        """
        value = (self.NODE_KEY or "").strip()
        if _decode_node_key(value) is None:
            return False
        self.NODE_KEY_PATH = _write_node_key_file(value)
        return True

    @property
    def web_origins(self) -> list[str]:
        return [o.strip() for o in self.WEB_ORIGINS.split(",") if o.strip()]

    @property
    def jobs_mode(self) -> str:
        """The effective job mode: ``eager``, ``thread`` or ``external``.

        An explicit ``JOBS_MODE`` wins; otherwise ``JOBS_EAGER`` decides (unset
        or 1 -> ``eager``, 0 -> ``thread``).  Resolved on every read so both
        knobs can be changed after construction.  An unrecognised ``JOBS_MODE``
        is returned as written; :meth:`validate_for_environment` refuses it.
        """
        explicit = (self.JOBS_MODE or "").strip().lower()
        if explicit:
            return explicit
        return "eager" if self.JOBS_EAGER else "thread"

    def validate_for_environment(self) -> None:
        """Refuse to run production with development-only defaults."""
        environment = _normalise_environment(self.SCHOLIUM_ENV)
        if self.jobs_mode not in _JOBS_MODES:
            # A typo must not silently fall back to running jobs inline (or not
            # at all), in any environment.
            raise RuntimeError(
                f"Unknown JOBS_MODE {self.JOBS_MODE!r}; expected one of "
                + ", ".join(_JOBS_MODES) + "."
            )
        if (self.STORAGE_BACKEND or "").strip().lower() not in _STORAGE_BACKENDS:
            # Likewise a typo must not quietly store objects somewhere else.
            raise RuntimeError(
                f"Unknown STORAGE_BACKEND {self.STORAGE_BACKEND!r}; expected one of "
                + ", ".join(_STORAGE_BACKENDS) + "."
            )
        # Read as ``get_provider`` reads it (unset or empty means fake), so a
        # value accepted here is one ``get_provider`` can build.
        provider = (self.AI_PROVIDER or "fake").strip().lower()
        if provider not in _AI_PROVIDERS:
            # Nor may a typo leave every review failing at its first request.
            raise RuntimeError(
                f"Unknown AI_PROVIDER {self.AI_PROVIDER!r}; expected one of "
                + ", ".join(_AI_PROVIDERS) + "."
            )
        if environment != "production":
            if environment != "dev":
                raise RuntimeError(
                    f"Unknown SCHOLIUM_ENV {self.SCHOLIUM_ENV!r}; "
                    "expected 'dev', 'prod' or 'production'."
                )
            return
        problems = []
        scheme = urlparse((self.DATABASE_URL or "").strip()).scheme.lower()
        if scheme not in _POSTGRES_SCHEMES:
            problems.append(
                "DATABASE_URL must be a PostgreSQL URL in production (SQLite is deprecated)"
            )
        if (self.STORAGE_BACKEND or "").strip().lower() != "s3":
            problems.append("STORAGE_BACKEND must be s3 in production")
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
        committee_key = (self.COMMITTEE_PUBLIC_KEY or "").strip()
        if not committee_key:
            problems.append("COMMITTEE_PUBLIC_KEY must be set for review escrow")
        else:
            # Escrow is the authority on the key format (hex or base64, 32
            # bytes); reuse it so a key that would fail at sealing time is
            # refused at startup instead.
            from app.modules.reviews.escrow import CommitteeKeyError, _decode_key

            try:
                _decode_key(committee_key)
            except CommitteeKeyError:
                problems.append("COMMITTEE_PUBLIC_KEY must be 32 bytes of hex or base64")
        if not (self.SMTP_URL or "").strip():
            problems.append("SMTP_URL must be set so verification and notification emails are delivered")
        problems.extend(self._node_key_problems())
        if not (self.ORCID_CLIENT_ID or "").strip() or not (self.ORCID_CLIENT_SECRET or "").strip():
            problems.append("ORCID_CLIENT_ID and ORCID_CLIENT_SECRET must be set")
        if self.ORCID_MOCK:
            problems.append("ORCID_MOCK must be 0")
        if self.ARXIV_MOCK:
            problems.append("ARXIV_MOCK must be 0")
        if self.jobs_mode == "eager":
            problems.append(
                "JOBS_EAGER must be 0 (jobs run on the background worker), "
                "or JOBS_MODE must be thread or external"
            )
        sandbox_backend = (self.SANDBOX_BACKEND or "docker").strip().lower()
        if sandbox_backend not in _SANDBOX_BACKENDS:
            problems.append(
                "SANDBOX_BACKEND must be one of " + ", ".join(_SANDBOX_BACKENDS)
            )
        elif sandbox_backend == "remote":
            if not (self.SANDBOX_URL or "").strip():
                problems.append(
                    "SANDBOX_URL must be set when SANDBOX_BACKEND is remote"
                )
            if len((self.SANDBOX_TOKEN or "").strip()) < 32:
                problems.append(
                    "SANDBOX_TOKEN must be a random value of at least 32 characters "
                    "when SANDBOX_BACKEND is remote"
                )
        problems.extend(self._storage_problems())
        if provider == "fake":
            problems.append("AI_PROVIDER must not be fake")
        key_env = _HOSTED_AI_KEY_ENV.get(provider)
        if key_env and not _env(key_env, "").strip():
            problems.append(f"{key_env} must be set when AI_PROVIDER is {provider}")
        if provider == "openai":
            problems.extend(self._openai_problems())
        if not self.RATE_LIMIT_ENABLED:
            problems.append("RATE_LIMIT_ENABLED must be 1 so write throttling is active in production")
        if "*" in self.web_origins:
            problems.append("WEB_ORIGINS must list explicit origins")
        else:
            if any(_is_loopback_url(origin) for origin in self.web_origins):
                problems.append("WEB_ORIGINS must not point at localhost in production")
            insecure_origins = [
                origin
                for origin in self.web_origins
                if urlparse(origin).scheme.lower() != "https"
            ]
            if insecure_origins:
                problems.append(
                    "WEB_ORIGINS must use https in production: "
                    + ", ".join(insecure_origins)
                )
        if _is_loopback_url(self.NEXT_PUBLIC_API_URL):
            problems.append("NEXT_PUBLIC_API_URL must not point at localhost in production")
        if problems:
            raise RuntimeError("Unsafe production configuration: " + "; ".join(problems))

    def _openai_problems(self) -> list[str]:
        """What ``AI_PROVIDER=openai`` lacks to run in production.

        The messages name the settings only; they never quote a key.
        """
        problems = []
        # The attribute is what the provider sends; the environment is read too
        # (as for ANTHROPIC_API_KEY) so a key exported after construction counts.
        if not ((self.OPENAI_API_KEY or "").strip() or _env("OPENAI_API_KEY").strip()):
            problems.append("OPENAI_API_KEY must be set when AI_PROVIDER is openai")
        # The attribute's default is an Anthropic model id, which an
        # OpenAI-compatible server would reject, so the variable itself must be set.
        if not _env("AI_HOSTED_MODEL").strip():
            problems.append(
                "AI_HOSTED_MODEL must be set to a model the server serves when "
                "AI_PROVIDER is openai (its default is an Anthropic model id)"
            )
        return problems

    def _storage_problems(self) -> list[str]:
        """What an ``s3`` storage backend lacks to run in production (``fs`` lacks nothing)."""
        if (self.STORAGE_BACKEND or "").strip().lower() != "s3":
            return []
        problems = []
        if not (self.S3_BUCKET or "").strip():
            problems.append("S3_BUCKET must be set when STORAGE_BACKEND is s3")
        if not (self.S3_ACCESS_KEY_ID or "").strip() or not (self.S3_SECRET_ACCESS_KEY or "").strip():
            problems.append(
                "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set when STORAGE_BACKEND is s3"
            )
        return problems

    def _node_key_problems(self) -> list[str]:
        """Why the node signing key is unusable, as messages that never quote ``NODE_KEY``."""
        if (self.NODE_KEY or "").strip():
            try:
                provisioned = self.apply_node_key()
            except OSError as exc:
                return [
                    "NODE_KEY could not be written to a private key file "
                    f"({exc.strerror or type(exc).__name__})"
                ]
            if not provisioned:
                return [
                    "NODE_KEY must hold a valid Ed25519 key "
                    "(a 32-byte seed or 64-byte secret key, hex or base64 encoded)"
                ]
        node_key_path = (self.NODE_KEY_PATH or "").strip()
        if not node_key_path or not os.path.isfile(node_key_path):
            return [f"NODE_KEY_PATH must point at an existing node key file (got {node_key_path!r})"]
        # The runtime reads the key with this same loader; a file that exists
        # but holds no usable Ed25519 key cannot sign anything.
        from app.modules.ledger.origin import node_signing_key

        if node_signing_key(node_key_path) is None:
            return [f"NODE_KEY_PATH must hold a valid Ed25519 key (got {node_key_path!r})"]
        return []


settings = Settings()