"""Claiming an imported paper (plugin: imports, feature 125).

An ``external.mirror`` (feature 124) is *unclaimed*: the node mirrored a
preprint on its authors' behalf and none of them has said so.  An author claims
it by signing an ordinary ``paper.version`` whose body also names the mirror::

    {"paper": "bafyrei...",          # the paper.genesis the version belongs to
     "n": 1,
     ...,                             # the usual paper.version fields
     "mirror": "bafyrei..."}          # cid of the external.mirror being claimed

When that version is accepted, and the signer's ORCID iD is one the mirror
itself names for an author, the paper's ``papers`` row is saved with
``claimed = true``.

Why ``paper`` stays the genesis
-------------------------------

``body.paper`` is still the cid of a real ``paper.genesis``: the record core's
verifier (and its TypeScript port) refuse a version chain that does not root at
one, and the ``paper.version`` handler (feature 50) only accepts versions of
papers it knows.  The mirror is a *second* reference, in an extra body member
(:data:`MIRROR_FIELD`; the schema allows extra members), so the claim neither
changes what a version is nor needs a schema of its own.

What "the signer's ORCID matches" means
---------------------------------------

* The **signer's ORCID** is the iD of the ORCID ownership credential linked to
  the signing DID (features 32/33) -- :func:`app.modules.profiles.read_orcid`,
  the same lookup ``GET /v1/profiles/{did}`` shows, so a revoked or suspended
  credential no longer counts.  It is *not* anything the version says about
  itself: a record can write any ``orcid`` it likes.
* The **paper's ORCIDs** are the ``orcid`` members of the mirror's
  ``metadata.authors`` entries that are objects.  The mirror is node-signed and
  immutable, so these are the one statement about who wrote the paper that the
  claimant cannot influence.
* They **match** when the signer's iD equals one of the paper's, compared
  after normalisation (``https://orcid.org/`` prefix removed, check digit
  upper-cased), so ``0000-0002-1825-009x`` and
  ``https://orcid.org/0000-0002-1825-009X`` are one iD.

The claim fails *closed*.  A mirror that names no author ORCID cannot be
claimed, and neither can one whose authors' iDs differ from the signer's.  This
matters because arXiv's API (and so the mock) lists authors by name only:
comparing names would let anyone with a profile name of "Ada Mock" claim Ada's
paper.  Claims therefore succeed only on mirrors whose author entries carry
ORCID iDs.

Not a refusal
-------------

A version that references a mirror but does not match is an ordinary version:
it is accepted, stored and appended exactly as it would be without the
reference, and the paper's ``claimed`` is left as it was.  So the claim is a
ledger *subscriber* (:func:`on_paper_version`), not an ingest handler: it runs
once the record is committed, it cannot veto the record, and an unexpected
failure is logged by the ledger rather than failing a submission that was
already stored.  Re-running :func:`claim_imported_paper` on the same entry is
safe -- the write is idempotent.

Which versions count
--------------------

Only a version this node accepted.  The subscriber hears every ``paper.version``
that reaches the log, but the claim requires the version's ``paper_versions``
row to exist and to name the same paper: that row is written by the
``paper.version`` handler, which has already checked the signer's tier, that the
paper is known and that the record extends the version chain.  A record that
reached the log some other way saves no claim.

The write
---------

``UPDATE papers SET claimed = true WHERE paper_cid = <body.paper>``.  A paper
the node holds only as a ledger record (no ``papers`` row; the version handler
allows that) has nothing to update, so nothing is claimed.  The mirror itself is
never rewritten.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy import update

from app import db
from app.modules import ledger
from app.modules.ingest import PAPER_VERSION_TYPE
from app.modules.ledger.models import EventLog
from app.modules.orcid import normalise_orcid
from app.modules.submissions import Paper, ensure_tables, get_version

from .service import MIRROR_TYPE

__all__ = [
    "MIRROR_FIELD",
    "Claim",
    "claim_imported_paper",
    "linked_orcid",
    "mark_claimed",
    "mirror_author_orcids",
    "mirror_reference",
    "on_paper_version",
]

logger = logging.getLogger(__name__)

#: The ``paper.version`` body member that names the ``external.mirror`` cid.
MIRROR_FIELD = "mirror"

#: A bare, normalised ORCID iD: four groups of four digits, the last character
#: being the MOD 11-2 check digit, which may be ``X``.
_ORCID_ID = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")


@dataclass(frozen=True)
class Claim:
    """One claim that was saved."""

    #: The paper (``papers.paper_cid``) now marked claimed.
    paper_cid: str
    #: The ``paper.version`` that made the claim.
    version_cid: str
    #: The ``external.mirror`` the version referenced.
    mirror_cid: str
    #: The DID that signed the version.
    signer: str
    #: The ORCID iD (normalised) the signer and the mirror have in common.
    orcid: str


def _orcid(value: object) -> Optional[str]:
    """``value`` as a normalised ORCID iD, or ``None`` when it is not shaped like one."""
    if not isinstance(value, str):
        return None
    text = normalise_orcid(value)
    return text if _ORCID_ID.match(text) else None


def mirror_reference(body: object) -> Optional[str]:
    """The mirror cid a ``paper.version`` body names, or ``None`` when it names none."""
    if not isinstance(body, Mapping):
        return None
    value = body.get(MIRROR_FIELD)
    return value if isinstance(value, str) and value else None


def mirror_author_orcids(mirror_body: object) -> frozenset[str]:
    """The ORCID iDs an ``external.mirror`` body names for its authors, normalised.

    Only ``metadata.authors`` entries that are objects with an ``orcid`` can
    name one; a plain author name (all arXiv supplies) names none, as does an
    ``orcid`` that is not shaped like an iD.
    """
    if not isinstance(mirror_body, Mapping):
        return frozenset()
    metadata = mirror_body.get("metadata")
    authors = metadata.get("authors") if isinstance(metadata, Mapping) else None
    if not isinstance(authors, (list, tuple)):
        return frozenset()
    found = {
        orcid
        for author in authors
        if isinstance(author, Mapping)
        for orcid in (_orcid(author.get("orcid")),)
        if orcid is not None
    }
    return frozenset(found)


def linked_orcid(did: str) -> Optional[str]:
    """The (normalised) ORCID iD linked to ``did`` by a current credential, or ``None``.

    Delegates to the profiles plugin, which owns the "which iD does this DID
    show" rule, so a claim and a profile never disagree.  Imported lazily so
    this plugin does not pull in another plugin's router at import time; a
    node without it has no linked iDs.
    """
    try:
        from app.modules.profiles import read_orcid
    except ImportError:  # pragma: no cover - profiles is a shipped plugin
        return None
    return _orcid(read_orcid(did))


def mark_claimed(paper_cid: str) -> bool:
    """Save ``claimed = true`` to the ``papers`` row of ``paper_cid``.

    Returns whether the node has such a row.  Idempotent: a paper that is
    already claimed stays claimed.
    """
    ensure_tables()
    with db.SessionLocal() as session:
        result = session.execute(
            update(Paper).where(Paper.paper_cid == paper_cid).values(claimed=True)
        )
        session.commit()
    return bool(result.rowcount)


def claim_imported_paper(entry: EventLog) -> Optional[Claim]:
    """Claim the paper ``entry`` (a ``paper.version``) belongs to, if it earns the claim.

    Returns the :class:`Claim` that was saved, or ``None`` when nothing was:
    the version names no mirror, this node did not accept the version, the
    reference is not an ``external.mirror`` this node holds, the mirror names no
    author ORCID, the signer has no linked ORCID, the two do not match, or the
    paper has no ``papers`` row.  None of these is an error; each is logged.
    """
    body = entry.body
    mirror_cid = mirror_reference(body)
    if mirror_cid is None:
        return None

    version_cid = entry.record_cid
    paper_cid = body.get("paper")
    if not isinstance(paper_cid, str) or not paper_cid:
        return None

    version = get_version(version_cid)
    if version is None or version.paper_cid != paper_cid:
        logger.info("not claiming from %s: this node did not accept it as a version of %s", version_cid, paper_cid)
        return None

    mirror = ledger.entry_by_cid(mirror_cid)
    if mirror is None or mirror.record_type != MIRROR_TYPE:
        logger.info("not claiming from %s: %s is not an external.mirror this node holds", version_cid, mirror_cid)
        return None

    paper_orcids = mirror_author_orcids(mirror.body)
    if not paper_orcids:
        logger.info("not claiming from %s: mirror %s names no author ORCID", version_cid, mirror_cid)
        return None

    signer = entry.author_did
    orcid = linked_orcid(signer)
    if orcid is None or orcid not in paper_orcids:
        logger.info("not claiming from %s: the signer's ORCID is not one of mirror %s's", version_cid, mirror_cid)
        return None

    if not mark_claimed(paper_cid):
        logger.info("not claiming from %s: this node has no papers row for %s", version_cid, paper_cid)
        return None

    logger.info("paper %s claimed by %s through version %s of mirror %s", paper_cid, signer, version_cid, mirror_cid)
    return Claim(
        paper_cid=paper_cid,
        version_cid=version_cid,
        mirror_cid=mirror_cid,
        signer=signer,
        orcid=orcid,
    )


def on_paper_version(entry: Any) -> None:
    """Ledger subscriber: claim the imported paper a just-appended version references."""
    claim_imported_paper(entry)


# The module loader imports this package once; ``subscribe`` is a no-op for a
# function that is already registered, so importing it again is harmless.
ledger.subscribe(PAPER_VERSION_TYPE, on_paper_version)
