"""The ``embeddings`` table and the operations on it (plugin: search).

Table shape (``app_spec.xml``, ``database_schema/embeddings``)::

    embeddings(version_cid TEXT PRIMARY KEY, vector BLOB NOT NULL)

One row per *listed* version, holding that version's embedding.  Like
``search_fts`` it is a projection of ``paper_versions``: a version has a row
only while it is ``listed`` and the row's vector comes from the embedder in
force (:func:`~.embedder.get_embedder`).  The text that is embedded is the
version's title, abstract and the start of its extracted text (see
:func:`embedding_text`).

The ``vector`` blob is self-describing, because a bare list of floats cannot
say which embedder made it and vectors from different embedders (or two
Ollama models) are not comparable::

    "SCV1"  | name_len: u8 | name: utf-8 (the embedder's name) | float32 little-endian x dimensions

A blob that does not parse, or that names another embedder, is treated as
absent and recomputed, so switching ``OLLAMA_URL`` on or off (or changing
``OLLAMA_EMBED_MODEL``) heals itself the next time a version is synced or
searched.

Rows are written when a version is listed (see :mod:`app.modules.search.subscribers`),
and :func:`embed_versions` fills any that are missing or stale at search time --
for versions listed before the plugin was installed, listed while the embedder
was down, or embedded by a previous embedder.  :func:`rebuild_embeddings` does
the same for every version and also drops rows of versions that are no longer
listed.
"""

from __future__ import annotations

import logging
import struct
import threading
from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

from sqlalchemy import Column, LargeBinary, Text, delete, inspect, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError

from app import db
from app.modules import checks
from app.modules.submissions import LISTED, PaperVersion, ensure_tables, get_version

from .embedder import Embedder, get_embedder

__all__ = [
    "BODY_CHARS",
    "Embedding",
    "StoredEmbedding",
    "decode_vector",
    "embed_versions",
    "embedding_text",
    "encode_vector",
    "ensure_table",
    "get_embedding",
    "put_embedding",
    "rebuild_embeddings",
    "remove_embedding",
    "sync_embedding",
]

logger = logging.getLogger(__name__)

_MAGIC = b"SCV1"

#: How much of a version's extracted text is embedded.  Embedding models have
#: a bounded context and the opening of a paper says what it is about; the
#: whole text would also drown the title and abstract in the hashing embedder.
BODY_CHARS = 4000

#: Versions embedded per embedder call when filling missing vectors.
_BATCH = 32


class Embedding(db.Base):
    """The embedding of one listed version."""

    __tablename__ = "embeddings"

    version_cid = Column(Text, primary_key=True)
    vector = Column(LargeBinary, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Embedding version_cid={self.version_cid!r} bytes={len(self.vector or b'')}>"


@dataclass(frozen=True)
class StoredEmbedding:
    """A decoded ``embeddings.vector``."""

    embedder: str
    vector: tuple[float, ...]


# --------------------------------------------------------------------------- #
# The table
# --------------------------------------------------------------------------- #

# ``main.create_app`` creates the table with the rest; callers that never build
# the app (scripts, tests) get it on first use, like the other modules.
_table_lock = threading.Lock()
_table_engine: Optional[Engine] = None


def ensure_table() -> None:
    """Create ``embeddings`` if it is missing."""
    global _table_engine
    if _table_engine is db.engine:
        return
    with _table_lock:
        if _table_engine is db.engine:
            return
        try:
            Embedding.__table__.create(bind=db.engine, checkfirst=True)
        except (OperationalError, ProgrammingError):
            # ``checkfirst`` is not atomic: another process may have created
            # the table in between.
            if not inspect(db.engine).has_table(Embedding.__tablename__):
                raise
        _table_engine = db.engine


# --------------------------------------------------------------------------- #
# The blob
# --------------------------------------------------------------------------- #


def encode_vector(embedder: str, vector: Sequence[float]) -> bytes:
    """The ``embeddings.vector`` blob for ``vector`` made by the embedder called ``embedder``."""
    name = embedder.encode("utf-8")
    if not 0 < len(name) < 256:
        raise ValueError("embedder name must be 1-255 bytes")
    if not vector:
        raise ValueError("cannot store an empty vector")
    return _MAGIC + bytes([len(name)]) + name + struct.pack(f"<{len(vector)}f", *vector)


def decode_vector(blob: object) -> Optional[StoredEmbedding]:
    """Parse a blob written by :func:`encode_vector`; ``None`` if it is anything else."""
    if not isinstance(blob, (bytes, bytearray, memoryview)):
        return None
    data = bytes(blob)
    if len(data) < len(_MAGIC) + 1 or not data.startswith(_MAGIC):
        return None
    name_len = data[len(_MAGIC)]
    start = len(_MAGIC) + 1 + name_len
    payload = data[start:]
    if name_len == 0 or len(data) < start or not payload or len(payload) % 4:
        return None
    try:
        name = data[len(_MAGIC) + 1 : start].decode("utf-8")
    except UnicodeDecodeError:
        return None
    return StoredEmbedding(name, struct.unpack(f"<{len(payload) // 4}f", payload))


# --------------------------------------------------------------------------- #
# Rows
# --------------------------------------------------------------------------- #


def put_embedding(version_cid: str, embedder: str, vector: Sequence[float]) -> None:
    """Make ``vector`` the one ``embeddings`` row of ``version_cid`` (insert or replace)."""
    ensure_table()
    blob = encode_vector(embedder, vector)
    # Update-then-insert, retried as an update when another writer inserts first:
    # correct across processes and on every database, unlike a read-then-write.
    # Each step is its own transaction (no SAVEPOINT, which pysqlite handles badly).
    for _ in range(3):
        with db.engine.begin() as connection:
            updated = connection.execute(
                update(Embedding).where(Embedding.version_cid == version_cid).values(vector=blob)
            )
        if updated.rowcount:
            return
        try:
            with db.engine.begin() as connection:
                connection.execute(
                    Embedding.__table__.insert().values(version_cid=version_cid, vector=blob)
                )
            return
        except IntegrityError:
            continue
    raise RuntimeError(f"could not store the embedding of {version_cid!r}")  # pragma: no cover


def get_embedding(version_cid: str) -> Optional[StoredEmbedding]:
    """The decoded embedding of ``version_cid``, or ``None`` (no row, or an unreadable one)."""
    if not isinstance(version_cid, str):
        return None
    ensure_table()
    with db.engine.connect() as connection:
        blob = connection.execute(
            select(Embedding.vector).where(Embedding.version_cid == version_cid)
        ).scalar_one_or_none()
    return decode_vector(blob)


def remove_embedding(version_cid: str) -> bool:
    """Delete the ``embeddings`` row of ``version_cid``; whether there was one."""
    if not isinstance(version_cid, str):
        return False
    ensure_table()
    with db.engine.begin() as connection:
        result = connection.execute(delete(Embedding).where(Embedding.version_cid == version_cid))
        return result.rowcount > 0


# --------------------------------------------------------------------------- #
# Keeping rows current
# --------------------------------------------------------------------------- #


def embedding_text(version_cid: str, title: str, abstract: str) -> str:
    """The text embedded for a version: title, abstract, then the start of its extracted text."""
    parts = [title, abstract]
    remaining = BODY_CHARS
    for paragraph in checks.get_version_text(version_cid):
        if remaining <= 0:
            break
        parts.append(paragraph.text[:remaining])
        remaining -= len(paragraph.text) + 2
    return "\n\n".join(p for p in parts if p)


def sync_embedding(version_cid: str, embedder: Optional[Embedder] = None) -> bool:
    """Make the ``embeddings`` row of ``version_cid`` agree with ``paper_versions``.

    A ``listed`` version gets a row with its current text embedded by the
    embedder in force, replacing any earlier row.  A version in any other
    state -- or one this node does not hold -- has no row afterwards.  Safe to
    call at any time and any number of times.

    Returns whether the version has an embedding afterwards.  Raises
    :class:`~.embedder.EmbedderError` when it needs a vector and the embedder
    cannot give one (any existing row is left as it was).
    """
    if not isinstance(version_cid, str) or not version_cid:
        return False
    ensure_tables()
    version = get_version(version_cid)
    if version is None or version.state != LISTED:
        remove_embedding(version_cid)
        return False
    embedder = embedder or get_embedder()
    text = embedding_text(version_cid, version.title, version.abstract)
    put_embedding(version_cid, embedder.name, embedder.embed([text])[0])
    # The version may have been unlisted while the embedder was working (its own
    # notification can have run first and found nothing to remove).
    current = get_version(version_cid)
    if current is None or current.state != LISTED:
        remove_embedding(version_cid)
        return False
    return True


def embed_versions(
    version_cids: Iterable[str], embedder: Optional[Embedder] = None
) -> dict[str, tuple[float, ...]]:
    """Embed each listed version in ``version_cids`` and store the result.

    Replaces whatever row a version had.  A version that is not listed (or not
    held) is skipped.  Returns the vectors it stored, by version cid.  Used at
    search time to fill versions that have no row from the embedder in force --
    listed before the plugin was installed, listed while the embedder was down,
    or embedded by a previous embedder -- so ranking never mixes vector spaces
    and never skips a listed version.  Raises :class:`~.embedder.EmbedderError`
    if the embedder fails.
    """
    embedder = embedder or get_embedder()
    pending = list(version_cids)
    stored: dict[str, tuple[float, ...]] = {}
    for start in range(0, len(pending), _BATCH):
        batch = []
        for cid in pending[start : start + _BATCH]:
            version = get_version(cid)
            if version is not None and version.state == LISTED:
                batch.append((cid, embedding_text(cid, version.title, version.abstract)))
        if not batch:
            continue
        vectors = embedder.embed([text for _, text in batch])
        for (cid, _), vector in zip(batch, vectors):
            put_embedding(cid, embedder.name, vector)
            stored[cid] = tuple(vector)
    return stored


def rebuild_embeddings(embedder: Optional[Embedder] = None) -> int:
    """Make ``embeddings`` agree with ``paper_versions`` for every version.

    Re-embeds every listed version and removes every row whose version is not
    listed (or no longer exists); returns how many versions it holds.  The
    repair for a notification that was never delivered or an embedder that was
    unreachable at the time.
    """
    ensure_table()
    ensure_tables()
    embedder = embedder or get_embedder()
    with db.SessionLocal() as session:
        listed = list(
            session.scalars(select(PaperVersion.version_cid).where(PaperVersion.state == LISTED))
        )
        stored = set(session.scalars(select(Embedding.version_cid)))
    for stale in stored - set(listed):
        remove_embedding(stale)
    count = 0
    for cid in listed:
        count += sync_embedding(cid, embedder)
    return count
