"""Pluggable text embedders for semantic search (plugin: search).

An *embedder* turns text into a fixed-length vector so that texts about the
same thing land close together; ``GET /v1/search/semantic`` ranks listed
versions by the cosine similarity between the query's vector and each
version's stored one.  Two ship here:

:class:`HashingEmbedder` (the default)
    Deterministic and dependency-free.  It hashes each word (and the 4-letter
    pieces of longer words, so ``pulsar`` and ``pulsars`` are close) into a
    fixed number of buckets with a sign, weights by sub-linear term frequency
    and normalises.  It knows nothing about meaning -- two texts are similar to
    the extent they share words -- but it is stable across processes and
    machines, needs no model and costs microseconds, which is what a node with
    no model server needs.

:class:`OllamaEmbedder`
    Calls a self-hosted Ollama server's ``/api/embed``.  Selected whenever the
    ``OLLAMA_URL`` environment variable is set to something non-empty; the
    model is ``OLLAMA_EMBED_MODEL`` (``nomic-embed-text`` if unset).  Text goes
    only to the operator's own server, so it is safe for any listed paper.

:func:`get_embedder` makes the choice **on every call** from the environment.
``app.settings.settings.OLLAMA_URL`` is deliberately not used: it defaults to
``http://localhost:11434``, which would make Ollama the default everywhere,
whereas the spec makes the hashing embedder the default and Ollama opt-in.

Every embedder has a ``name`` that identifies its vector space.  Vectors from
different embedders -- or two Ollama models -- are not comparable, so the name
is stored with each vector (see :mod:`app.modules.search.embeddings`) and a
vector from another embedder is recomputed rather than ranked.

Anything with a ``name`` and an ``embed`` method is an embedder;
:func:`set_embedder` installs one process-wide (tests use it, and so can a
deployment that wants a different model).
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import unicodedata
from collections import Counter
from functools import lru_cache
from typing import Any, Optional, Protocol, Sequence, runtime_checkable

import httpx

__all__ = [
    "DEFAULT_OLLAMA_MODEL",
    "Embedder",
    "EmbedderError",
    "HashingEmbedder",
    "OllamaEmbedder",
    "cosine_similarity",
    "get_embedder",
    "set_embedder",
    "tokenize",
]

#: Used when ``OLLAMA_EMBED_MODEL`` is unset.
DEFAULT_OLLAMA_MODEL = "nomic-embed-text"


class EmbedderError(RuntimeError):
    """An embedder could not produce vectors (server down, bad reply, ...)."""


@runtime_checkable
class Embedder(Protocol):
    """What the search plugin needs from an embedder."""

    #: Identifies the vector space; two embedders with one name must produce
    #: comparable vectors.
    name: str

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """One vector per text, in order.  Raises :class:`EmbedderError` on failure."""
        ...


# --------------------------------------------------------------------------- #
# Hashing embedder
# --------------------------------------------------------------------------- #

_WORD = re.compile(r"\w+", re.UNICODE)

#: Words too common to say anything about a paper.  A stateless embedder cannot
#: learn document frequencies, so dropping the commonest words stands in for
#: IDF weighting; without it every pair of abstracts would look alike.
_STOPWORDS = frozenset(
    """
    a about above after again all also am an and any are as at be because been
    before being below between both but by can could did do does doing down
    during each few for from further had has have having he her here hers him
    his how i if in into is it its itself just me more most my no nor not of off
    on once only or other our ours out over own same she should so some such than
    that the their theirs them then there these they this those through to too
    under until up us very was we were what when where which while who whom why
    will with would you your yours
    """.split()
)

#: Length of the character pieces (taken from ``#word#``) that give the
#: embedding some tolerance for plurals and inflections.
_PIECE_LEN = 4
#: A piece counts for this much of a whole word.
_PIECE_WEIGHT = 0.3


def tokenize(text: str) -> list[str]:
    """Lower-cased word tokens of ``text`` (Unicode-normalised, punctuation dropped)."""
    return _WORD.findall(unicodedata.normalize("NFKC", text).casefold())


@lru_cache(maxsize=1 << 16)
def _bucket(feature: str, dim: int) -> tuple[int, int]:
    """The ``(index, sign)`` a feature hashes to.

    blake2b rather than ``hash()``: the latter is salted per process, which
    would make stored vectors meaningless after a restart.
    """
    value = int.from_bytes(hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest(), "big")
    return value % dim, (1 if value >> 63 else -1)


class HashingEmbedder:
    """Feature-hashing bag-of-words embedder.  Deterministic; no model needed."""

    def __init__(self, dimensions: int = 1024) -> None:
        if dimensions < 8:
            raise ValueError("dimensions must be at least 8")
        self.dimensions = dimensions
        self.name = f"hashing-v1-{dimensions}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        words = Counter(t for t in tokenize(text) if t not in _STOPWORDS)
        pieces: Counter[str] = Counter()
        for word, count in words.items():
            if len(word) >= _PIECE_LEN:
                padded = f"#{word}#"
                for i in range(len(padded) - _PIECE_LEN + 1):
                    pieces[padded[i : i + _PIECE_LEN]] += count

        vector = [0.0] * self.dimensions
        for kind, counts, weight in (("w", words, 1.0), ("c", pieces, _PIECE_WEIGHT)):
            for feature, count in counts.items():
                index, sign = _bucket(f"{kind}:{feature}", self.dimensions)
                vector[index] += sign * weight * (1.0 + math.log(count))
        norm = math.sqrt(math.sumprod(vector, vector))
        if norm == 0.0:
            return vector
        return [x / norm for x in vector]


# --------------------------------------------------------------------------- #
# Ollama embedder
# --------------------------------------------------------------------------- #


class OllamaEmbedder:
    """Embeds with a self-hosted Ollama server (``POST {url}/api/embed``).

    ``client`` may be injected (tests pass one over ``httpx.MockTransport``);
    otherwise an ``httpx.Client`` is created lazily.  The connect timeout is
    short so that a node whose Ollama is down fails quickly instead of stalling
    the request (or the version transition) that wanted a vector; the read
    timeout is long because the first call may have to load the model.
    """

    def __init__(
        self,
        base_url: str,
        model: str = DEFAULT_OLLAMA_MODEL,
        client: Optional[Any] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.name = f"ollama:{model}"
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = httpx.Client(timeout=httpx.Timeout(60.0, connect=2.0))
        return self._client

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            response = self._get_client().post(
                f"{self.base_url}/api/embed",
                json={"model": self.model, "input": list(texts)},
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EmbedderError(f"Ollama embedding request failed: {exc}") from exc
        return self._vectors(payload, expected=len(texts))

    @staticmethod
    def _vectors(payload: Any, expected: int) -> list[list[float]]:
        vectors = payload.get("embeddings") if isinstance(payload, dict) else None
        if not isinstance(vectors, list) or len(vectors) != expected:
            raise EmbedderError("Ollama returned the wrong number of embeddings")
        result: list[list[float]] = []
        for vector in vectors:
            if (
                not isinstance(vector, list)
                or not vector
                or not all(
                    isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)
                    for x in vector
                )
            ):
                raise EmbedderError("Ollama returned a malformed embedding")
            result.append([float(x) for x in vector])
        return result


# --------------------------------------------------------------------------- #
# Choosing the embedder
# --------------------------------------------------------------------------- #

_HASHING = HashingEmbedder()
_override: Optional[Embedder] = None


@lru_cache(maxsize=4)
def _ollama(url: str, model: str) -> OllamaEmbedder:
    # Cached so the HTTP client (and its connection pool) is reused.
    return OllamaEmbedder(url, model)


def set_embedder(embedder: Optional[Embedder]) -> None:
    """Use ``embedder`` for everything, regardless of the environment.

    ``None`` goes back to choosing from the environment.
    """
    global _override
    _override = embedder


def get_embedder() -> Embedder:
    """The embedder in force: the installed one, else Ollama if ``OLLAMA_URL`` is set, else hashing."""
    if _override is not None:
        return _override
    url = os.environ.get("OLLAMA_URL", "").strip()
    if url:
        model = os.environ.get("OLLAMA_EMBED_MODEL", "").strip() or DEFAULT_OLLAMA_MODEL
        return _ollama(url, model)
    return _HASHING


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine of the angle between ``a`` and ``b``; ``0.0`` if either is the zero vector.

    Raises ``ValueError`` when the lengths differ -- vectors from different
    embedders have no similarity.
    """
    if len(a) != len(b):
        raise ValueError("vectors have different lengths")
    norm = math.sqrt(math.sumprod(a, a)) * math.sqrt(math.sumprod(b, b))
    if norm == 0.0:
        return 0.0
    return math.sumprod(a, b) / norm
