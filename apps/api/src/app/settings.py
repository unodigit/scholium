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

#: Hosted AI providers and the environment variable holding their API key.
_HOSTED_AI_KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY"}

#: Accepted spellings of ``SCHOLIUM_ENV``, mapped to their canonical value.
#: Anything else is unknown and is refused by
#: :meth:`Settings.validate_for_environment` rather than starting the app.
_ENV_ALIASES = {"dev": "dev", "prod": "production", "production": "production"}


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


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
    DATABASE_URL: str = field(default_factory=lambda: _env("DATABASE_URL", "sqlite:///./scholium.db"))
    CONTENT_DIR: str = field(default_factory=lambda: _env("CONTENT_DIR", "./data/content"))
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
    AI_PROVIDER: str = field(default_factory=lambda: _env("AI_PROVIDER", "fake"))
    AI_HOSTED_MODEL: str = field(default_factory=lambda: _env("AI_HOSTED_MODEL", "claude-sonnet-5-5"))
    OLLAMA_URL: str = field(default_factory=lambda: _env("OLLAMA_URL", "http://localhost:11434"))
    SMTP_URL: str = field(default_factory=lambda: _env("SMTP_URL", ""))
    JOBS_EAGER: int = field(default_factory=lambda: _int("JOBS_EAGER", 1))
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

    def validate_for_environment(self) -> None:
        """Refuse to run production with development-only defaults."""
        environment = _normalise_environment(self.SCHOLIUM_ENV)
        if environment != "production":
            if environment != "dev":
                raise RuntimeError(
                    f"Unknown SCHOLIUM_ENV {self.SCHOLIUM_ENV!r}; "
                    "expected 'dev', 'prod' or 'production'."
                )
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
        if self.JOBS_EAGER:
            problems.append("JOBS_EAGER must be 0 (jobs run on the background worker)")
        provider = (self.AI_PROVIDER or "").strip().lower()
        if provider == "fake":
            problems.append("AI_PROVIDER must not be fake")
        key_env = _HOSTED_AI_KEY_ENV.get(provider)
        if key_env and not _env(key_env, "").strip():
            problems.append(f"{key_env} must be set when AI_PROVIDER is {provider}")
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