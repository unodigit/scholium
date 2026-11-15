"""Storing and reading an account's recovery guardians (plugin: recovery).

An account names exactly :data:`GUARDIAN_COUNT` guardians, each a canonical
Ed25519 ``did:key`` (the same identifiers sign-in accepts, since guardians later
sign recovery approvals with their own keys). Setting guardians *replaces* the
account's whole list in one transaction, so there is never a half-written set,
and a rejected list leaves the previous one untouched.

A guardian list is rejected when it:

* does not have exactly five entries;
* holds an entry that is not a canonical Ed25519 ``did:key``;
* names the same guardian more than once;
* names the account itself: a guardian is whoever can recover the account when
  its own key is lost, so the account cannot be its own.

Every fault is reported, not just the first, so a client can fix them in one go.
"""

from __future__ import annotations

from typing import Any, Sequence

from sqlalchemy import func, select

from app import db
from app.modules.identity.service import InvalidDid, validate_did

from .models import Guardian, ensure_table

__all__ = [
    "GUARDIAN_COUNT",
    "InvalidGuardians",
    "get_guardians",
    "has_guardians",
    "set_guardians",
    "validate_guardians",
]

#: How many guardians an account names (3 of these 5 approve a recovery).
GUARDIAN_COUNT = 5


class InvalidGuardians(ValueError):
    """A guardian list cannot be saved; :attr:`problems` lists every fault.

    Each problem is a FastAPI-style error entry: ``loc`` (where in the request
    body), ``msg`` and ``type``.
    """

    def __init__(self, problems: Sequence[dict[str, Any]]) -> None:
        self.problems = list(problems)
        super().__init__("; ".join(problem["msg"] for problem in self.problems))


def _problem(loc: Sequence[Any], msg: str, kind: str) -> dict[str, Any]:
    return {"loc": ["body", "guardians", *loc], "msg": msg, "type": kind}


def validate_guardians(owner_did: str, guardian_dids: Sequence[Any]) -> list[str]:
    """Return ``guardian_dids`` as a list if it is a valid guardian set for ``owner_did``.

    Raises :class:`InvalidGuardians`, naming every fault, otherwise.
    """
    problems: list[dict[str, Any]] = []
    if len(guardian_dids) != GUARDIAN_COUNT:
        problems.append(
            _problem(
                [],
                f"Exactly {GUARDIAN_COUNT} guardians are required, got {len(guardian_dids)}.",
                "guardian_count",
            )
        )

    first_seen: dict[str, int] = {}
    for index, guardian_did in enumerate(guardian_dids):
        try:
            validate_did(guardian_did)
        except InvalidDid as exc:
            problems.append(_problem([index], f"Guardian {index} is {exc}.", "invalid_did"))
            continue
        if guardian_did == owner_did:
            problems.append(
                _problem([index], f"Guardian {index} is your own DID; a guardian must be someone else.", "self_guardian")
            )
        elif guardian_did in first_seen:
            problems.append(
                _problem(
                    [index],
                    f"Guardian {index} repeats guardian {first_seen[guardian_did]}; each guardian must be distinct.",
                    "duplicate_guardian",
                )
            )
        else:
            first_seen[guardian_did] = index

    if problems:
        raise InvalidGuardians(problems)
    return list(guardian_dids)


def set_guardians(did: str, guardian_dids: Sequence[Any]) -> list[str]:
    """Save ``guardian_dids`` as the guardians of ``did``, replacing any earlier set.

    Returns the saved list, in the order given (that order is each guardian's
    ``position``). Raises :class:`InvalidGuardians`, saving nothing, if the list
    is not valid.
    """
    guardians = validate_guardians(did, guardian_dids)
    ensure_table()
    with db.SessionLocal() as session:
        session.query(Guardian).filter(Guardian.did == did).delete(synchronize_session=False)
        session.add_all(
            Guardian(did=did, guardian_did=guardian_did, position=position)
            for position, guardian_did in enumerate(guardians)
        )
        session.commit()
    return guardians


def get_guardians(did: str) -> list[str]:
    """Return the guardians of ``did`` in position order; empty if none are set."""
    ensure_table()
    with db.SessionLocal() as session:
        rows = session.scalars(
            select(Guardian.guardian_did).where(Guardian.did == did).order_by(Guardian.position)
        )
        return list(rows)


def has_guardians(did: str) -> bool:
    """Whether ``did`` has a complete set of :data:`GUARDIAN_COUNT` guardians."""
    ensure_table()
    with db.SessionLocal() as session:
        count = session.scalar(select(func.count()).select_from(Guardian).where(Guardian.did == did))
    return count == GUARDIAN_COUNT
