"""``.demo-keys.json``: the Ed25519 keys of the demo accounts.

``seed-demo`` signs every record as the person it belongs to, so it needs a key
per demo account.  The keys are kept in a JSON file -- written next to where the
command runs, git-ignored -- so that

* running the command again acts as *the same people* (their ``did:key`` is the
  key), and does not pile up a second cast;
* the operator can sign in to the demo node as any of them, using the seed.

The file also holds an ``anchor`` instant: the time the demo history is told
from.  Every record's ``created`` is the anchor plus a fixed offset, which with
Ed25519's deterministic signatures makes every record byte-for-byte the same on
every run (so the node answers a repeat with ``409`` duplicate, see
:mod:`.seed`).

The seeds are secrets: anyone holding the file can sign as these accounts.  It
is created readable by its owner only, and replaced atomically so an interrupted
run never leaves it half-written.  A file that cannot be read is an error and is
never overwritten -- that would throw away keys the node's data refers to.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key

__all__ = ["DemoAccount", "DemoKeys", "DemoKeysError", "FORMAT_VERSION", "KEYS_FILENAME"]

KEYS_FILENAME = ".demo-keys.json"
FORMAT_VERSION = 1

#: How far before the first run the demo history's anchor lies, so no record's
#: ``created`` is ever in the future.
_ANCHOR_LEAD = timedelta(days=1)

_NOTE = (
    "Demo-only Ed25519 keys written by `python -m app.modules.admin seed-demo`. "
    "Anyone holding this file can sign as these accounts: keep it out of version "
    "control and never point it at a production node."
)


class DemoKeysError(Exception):
    """The keys file exists but is not a usable demo keys file."""


@dataclass(frozen=True)
class DemoAccount:
    """One demo account: who they are and the key that is their ``did:key``."""

    slug: str
    name: str
    role: str
    did: str
    seed: str  # the 32-byte Ed25519 seed, as 64 hex characters

    def signing_key(self) -> SigningKey:
        return SigningKey(bytes.fromhex(self.seed))


def _format_instant(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_instant(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("not a string")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _read_account(slug: str, entry: Any) -> DemoAccount:
    if not isinstance(entry, dict):
        raise DemoKeysError(f"account {slug!r} is not an object")
    fields = {}
    for field in ("name", "role", "did", "seed"):
        value = entry.get(field)
        if not isinstance(value, str) or not value:
            raise DemoKeysError(f"account {slug!r} has no {field!r}")
        fields[field] = value
    try:
        seed = bytes.fromhex(fields["seed"])
        key = SigningKey(seed)
    except (ValueError, TypeError) as exc:
        raise DemoKeysError(f"account {slug!r} has an invalid seed ({exc})") from None
    if did_key_from_signing_key(key) != fields["did"]:
        raise DemoKeysError(f"account {slug!r}: the did does not match its seed")
    return DemoAccount(slug=slug, **fields)


class DemoKeys:
    """The demo accounts' keys and the history anchor, backed by a JSON file."""

    def __init__(self, path: Path, anchor: datetime, accounts: dict[str, DemoAccount], *, created: bool):
        self.path = path
        self.anchor = anchor
        self._accounts = accounts
        #: True when there was no file yet, so this run starts a new cast.
        self.created = created

    @classmethod
    def load_or_create(cls, path: Path | str, *, now: Optional[datetime] = None) -> "DemoKeys":
        """Read the keys file at ``path``, or start a new one (not saved until :meth:`save`)."""
        path = Path(path).expanduser()
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            moment = (now or datetime.now(timezone.utc)).replace(second=0, microsecond=0)
            return cls(path, moment - _ANCHOR_LEAD, {}, created=True)
        except OSError as exc:
            raise DemoKeysError(f"cannot read {path}: {exc}") from None

        try:
            data = json.loads(text)
        except ValueError as exc:
            raise DemoKeysError(f"{path} is not valid JSON ({exc}); fix or delete it") from None
        if not isinstance(data, dict) or data.get("version") != FORMAT_VERSION:
            raise DemoKeysError(f"{path} is not a version {FORMAT_VERSION} demo keys file")
        try:
            anchor = _parse_instant(data.get("anchor"))
        except ValueError:
            raise DemoKeysError(f"{path} has no valid 'anchor' instant") from None
        raw = data.get("accounts")
        if not isinstance(raw, dict):
            raise DemoKeysError(f"{path} has no 'accounts' object")
        accounts = {slug: _read_account(slug, entry) for slug, entry in raw.items()}
        return cls(path, anchor, accounts, created=False)

    def account(self, slug: str, *, name: str, role: str) -> DemoAccount:
        """The account for ``slug``, with a fresh key if it has none yet."""
        existing = self._accounts.get(slug)
        if existing is not None:
            return existing
        key = SigningKey.generate()
        account = DemoAccount(
            slug=slug, name=name, role=role, did=did_key_from_signing_key(key), seed=bytes(key).hex()
        )
        self._accounts[slug] = account
        return account

    def accounts(self) -> list[DemoAccount]:
        return list(self._accounts.values())

    def save(self) -> None:
        """Write the file (owner-only, atomically)."""
        document = {
            "version": FORMAT_VERSION,
            "note": _NOTE,
            "anchor": _format_instant(self.anchor),
            "accounts": {
                slug: {"name": a.name, "role": a.role, "did": a.did, "seed": a.seed}
                for slug, a in self._accounts.items()
            },
        }
        directory = self.path.parent if str(self.path.parent) else Path(".")
        directory.mkdir(parents=True, exist_ok=True)
        # mkstemp creates the file 0600, so the seeds are never readable by others.
        fd, tmp_name = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, self.path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
