"""``init-node``: create the Ed25519 key this node signs its own records with.

A node signs more than the records people hand it: the renditions the scan
makes, the advisory AI pre-review, ORCID credential events, arXiv imports and
the sync head are all signed with one Ed25519 key -- the node's identity.  A
fresh checkout has no such key (nothing in the app writes one; it is the
operator's to make), and without it the node still works but signs nothing of
its own.  ``python -m app.modules.admin init-node`` makes the key, at
``NODE_KEY_PATH``.

Like :mod:`app.modules.admin.service`, this module stays importable by a plain
``uv run``: it pulls in no workspace package, so provisioning a node's key
needs no ``--all-packages``.  (The reading side is
:func:`app.modules.ledger.origin.node_signing_key`; the writing side lives
here, next to the command that uses it -- :mod:`app.modules.ledger` itself
cannot be imported without the record core.)

The file holds the 32-byte seed as 64 hex characters -- a form every reader
of the key accepts -- written owner-only (0600) and atomically, so an
interrupted run cannot leave it half-written.  An existing file is never
overwritten unless forced: a key that is already the node's identity, that
other nodes may have pinned, must not be silently replaced.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from multiformats import multibase
from nacl.signing import SigningKey

from app.settings import settings

__all__ = ["NodeKey", "NodeKeyExistsError", "init_node_key"]

#: Multicodec prefix for an Ed25519 public key inside a ``did:key`` (0xed 0x01),
#: the same bytes :mod:`app.modules.ledger.origin` builds its DIDs with.
_ED25519_MULTICODEC = b"\xed\x01"


class NodeKeyExistsError(RuntimeError):
    """There is already a key file where the node's key would go, and it was not forced."""


@dataclass(frozen=True)
class NodeKey:
    """The outcome of :func:`init_node_key`."""

    path: Path
    #: The ``did:key`` this node records as its origin once it signs with the key.
    did: str
    #: ``False`` when an existing key file was replaced (``--force``).
    created: bool


def _did_of(key: SigningKey) -> str:
    return "did:key:" + multibase.encode(_ED25519_MULTICODEC + key.verify_key.encode(), "base58btc")


def init_node_key(path: str | Path | None = None, *, force: bool = False) -> NodeKey:
    """Create the node's Ed25519 signing key at ``path`` (default ``NODE_KEY_PATH``).

    Missing parent directories are created; the file is written 0600, atomically,
    holding the key's seed as hex.  Raises :class:`NodeKeyExistsError` when the
    file is already there and ``force`` is not set -- never silently replacing
    a key that may be the identity other nodes know this node by.
    """
    target = Path(path or settings.NODE_KEY_PATH).expanduser()
    existed = target.exists()
    if existed and not force:
        raise NodeKeyExistsError(
            f"{target} already exists; it may be the identity other nodes know this node by, "
            "so it is not replaced (pass --force to overwrite it)"
        )
    key = SigningKey.generate()
    directory = target.parent if str(target.parent) else Path(".")
    directory.mkdir(parents=True, exist_ok=True)
    # mkstemp creates the file 0600, so the seed is never readable by others.
    fd, tmp_name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(bytes(key).hex() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return NodeKey(path=target.resolve(), did=_did_of(key), created=not existed)
