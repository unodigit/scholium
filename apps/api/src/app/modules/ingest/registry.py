"""The record-type handler registry.

Modules that own a record type register its handler when they are imported::

    from app.modules.ingest import register

    def handle_paper_genesis(record): ...

    register("paper.genesis", handle_paper_genesis, min_tier=2)

    # or, as a decorator:
    @register("review.rating", min_tier=3)
    def handle_review_rating(record): ...

The ingest pipeline then resolves the handler for an incoming record::

    registration = lookup(envelope["type"])   # raises UnknownRecordType (422)
    registration.min_tier                     # Tier the author must hold
    registration.handler(...)

Semantics:

* ``min_tier`` is required and is a trust tier from 0 to 4 (:class:`app.security.Tier`).
  There is deliberately no default: what a type demands of its author is an
  authorization decision for the module that owns the type, not something to
  fall into. The registry only records it; ingest enforces it.
* Record types match exactly (case-sensitive, no normalisation).
* One handler per type. Registering the same handler with the same tier again
  is a no-op, so re-importing a module is harmless; anything else for an
  already-registered type raises ``ValueError`` instead of silently replacing a
  handler (or loosening its tier).
* :func:`lookup` of a type nobody registered raises :class:`UnknownRecordType`,
  an ``HTTPException`` that the app renders as ``422`` problem details.
  :func:`get` is the non-raising variant.
* The registry does not call handlers and does not define their signature;
  that contract belongs to the ingest pipeline that invokes them.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable, Optional

from app.security import MAX_TIER, MIN_TIER, Tier

from .errors import UnknownRecordType

__all__ = [
    "HandlerRegistration",
    "RecordHandler",
    "get",
    "lookup",
    "register",
    "registered_types",
    "unregister",
]

RecordHandler = Callable[..., Any]


@dataclass(frozen=True)
class HandlerRegistration:
    """What a module registered for one record type."""

    record_type: str
    handler: RecordHandler
    min_tier: Tier


_registry: dict[str, HandlerRegistration] = {}
_lock = threading.Lock()

_UNSET: Any = object()


def _check_record_type(record_type: object) -> str:
    if not isinstance(record_type, str) or not record_type or record_type != record_type.strip():
        raise ValueError(
            f"record type must be a non-empty string without surrounding whitespace, got {record_type!r}"
        )
    return record_type


def _check_min_tier(min_tier: object) -> Tier:
    if isinstance(min_tier, bool) or not isinstance(min_tier, int) or not MIN_TIER <= min_tier <= MAX_TIER:
        raise ValueError(f"min_tier must be an integer from {int(MIN_TIER)} to {int(MAX_TIER)}, got {min_tier!r}")
    return Tier(min_tier)


def register(record_type: str, handler: Optional[RecordHandler] = None, min_tier: Any = _UNSET) -> Any:
    """Register ``handler`` for ``record_type``, requiring authors of tier ``min_tier`` or above.

    Works as ``register(record_type, handler, min_tier)`` (returning ``handler``)
    or as a decorator, ``@register(record_type, min_tier=...)``.

    Raises ``ValueError`` for an empty or whitespace-padded record type, a tier
    outside 0-4, or a type that already has a different handler or tier;
    ``TypeError`` when ``min_tier`` is omitted or ``handler`` is not callable.
    Arguments are checked when ``register`` is called, so a decorator fails at
    the line that declares it.
    """
    key = _check_record_type(record_type)
    if min_tier is _UNSET:
        raise TypeError(f"register({key!r}, ...) requires min_tier, the lowest trust tier allowed to submit it")
    tier = _check_min_tier(min_tier)

    def _add(fn: RecordHandler) -> RecordHandler:
        if not callable(fn):
            raise TypeError(f"the handler for record type {key!r} must be callable, got {type(fn).__name__}")
        with _lock:
            existing = _registry.get(key)
            if existing is not None:
                if existing.handler == fn and existing.min_tier == tier:
                    return fn
                raise ValueError(f"a handler is already registered for record type {key!r}")
            _registry[key] = HandlerRegistration(record_type=key, handler=fn, min_tier=tier)
        return fn

    return _add if handler is None else _add(handler)


def unregister(record_type: str) -> None:
    """Remove the registration for ``record_type``; a no-op when there is none."""
    with _lock:
        _registry.pop(record_type, None)


def get(record_type: object) -> Optional[HandlerRegistration]:
    """Return the registration for ``record_type``, or ``None`` when there is none."""
    if not isinstance(record_type, str):
        return None
    with _lock:
        return _registry.get(record_type)


def lookup(record_type: object) -> HandlerRegistration:
    """Return the registration for ``record_type``.

    Raises :class:`UnknownRecordType` (``422`` problem details) when no module
    registered that type, including when ``record_type`` is not a string at all.
    """
    registration = get(record_type)
    if registration is None:
        raise UnknownRecordType(record_type)
    return registration


def registered_types() -> list[str]:
    """Return the registered record types, sorted."""
    with _lock:
        return sorted(_registry)
