"""Drawing an appeal's 3-member panel (plugin: appeals, feature 75).

When an appeal is saved, three members who have standing to judge it are seated
in ``appeal_panels``.  Who may sit:

* **tier 3 or tier 4.**  Read from ``accounts`` when the panel is drawn
  (:data:`PANEL_TIERS`);
* **not the deciding moderator.**  The appeal answers *their* decision;
* **not an author of the paper** the decision was about -- which also keeps the
  appellant, always an author, off their own panel.

The draw is **seeded by an HMAC of the appealed decision cid** and by nothing
else that anyone but the node controls: the seed is
``HMAC-SHA256(secret, decision_cid)`` where ``secret`` is derived from the node's
own signing key (:func:`derive_panel_seed`), and every eligible member is scored
by ``sha256(seed, member_did)`` and the three lowest scores sit
(:func:`select_panel`).  Consequently

* the same appeal drawn over the same members always seats the same panel, in
  the same order, whatever order the members were listed in -- and the seed is
  stored on the appeal's row once, so the draw and the seat order stay fixed;
* the seed does **not** depend on the appeal.  The appellant signs the appeal
  record and so chooses its cid (its grounds and ``created`` change the hash),
  and can predict the ledger head it will be appended at: any seed built from
  either let them vary a no-op field of the appeal offline until a draw favoured
  them, then file that one.  The deciding moderator chooses the decision cid, so
  a bare hash of it could be ground by them -- which is why the seed is keyed:
  without the node's secret nobody can compute the draw, or search for a
  decision that produces the one they want, before the decision is made;
* different decisions draw unrelated panels, and neither the appellant, the
  deciding moderator nor an operator picks who sits;
* a member who joins or leaves the pool without being one of the three does not
  change the panel.

A node without a usable signing key has no secret and so no seed: it seats no
panel (``PanelSeedUnavailable``) until a key is provisioned.

:func:`get_panel` returns the seats in the same seeded order by reading the
seed stored on the appeal's row; a panel drawn for a cid with no saved appeal
row (a direct :func:`draw_panel` call) falls back to that cid as its seed.

A panel is drawn once.  :func:`draw_panel` saves exactly :data:`PANEL_SIZE`
rows, or none: with fewer eligible members it raises
:class:`~.errors.PanelUnavailable` and writes nothing, because a short panel
could never reach two matching votes of three.  Once seated a panel is never
redrawn, so a member's tier changing later does not unseat them.
"""

from __future__ import annotations

import hashlib
import hmac
import threading
from collections.abc import Collection, Iterable
from typing import Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import db
from app.modules.identity.models import Account, ensure_account_table

from .errors import PanelUnavailable
from .models import Appeal, AppealPanelMember, ensure_tables

__all__ = [
    "PANEL_SEED_DOMAIN",
    "PANEL_SIZE",
    "PANEL_TIERS",
    "derive_panel_seed",
    "draw_panel",
    "eligible_members",
    "get_panel",
    "panel_seed",
    "panel_seed_secret",
    "seat_rank",
    "select_panel",
]

#: Seats on a panel.  Two matching votes of three decide an appeal.
PANEL_SIZE = 3

#: Trust tiers whose members may sit on a panel.
PANEL_TIERS = (3, 4)

# Serialises drawing within this process, so the ledger subscriber and the
# endpoint (which both save an appeal) cannot seat two different panels if the
# membership changes between their reads.  Another process drawing the same
# appeal over the same members hits the primary key instead, and gets the panel
# that won.
_draw_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# The seed
# --------------------------------------------------------------------------- #

#: Domain separation for the secret derived from the node's signing key, so the
#: key that signs records is never itself used as an HMAC key for the draw.
PANEL_SEED_DOMAIN = b"scholium/appeals/panel-seed/v1"


def panel_seed_secret(key: object) -> bytes:
    """The node-held secret the panel seed is keyed by, derived from ``key``.

    ``key`` is the node's Ed25519 signing key
    (:func:`app.modules.ledger.node_signing_key`).  The secret is
    ``HMAC-SHA256(key, PANEL_SEED_DOMAIN)``: a one-way, domain-separated
    derivation, so the secret reveals nothing about the signing key and the
    signing key is not reused as a MAC key.
    """
    return hmac.new(bytes(key), PANEL_SEED_DOMAIN, hashlib.sha256).digest()  # type: ignore[call-overload]


def derive_panel_seed(decision_cid: str, key: object) -> str:
    """The seed for the panel of an appeal of ``decision_cid``: a hex HMAC-SHA256.

    ``HMAC-SHA256(panel_seed_secret(key), decision_cid)`` -- over the decision
    cid only.  Nothing the appellant writes (the appeal's cid, grounds or
    ``created``) and nothing about the ledger enters it, and without the node's
    secret neither the appellant nor the deciding moderator can compute it.
    """
    return hmac.new(panel_seed_secret(key), decision_cid.encode("utf-8"), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------- #
# The draw
# --------------------------------------------------------------------------- #


def seat_rank(seed: str, member_did: str) -> tuple[bytes, str]:
    """The sort key that decides who sits: lowest ``sha256(seed, did)`` first.

    ``seed`` is the appeal's stored panel seed (:func:`derive_panel_seed`).  The
    DID is the tie-breaker, so the order is total even for a hash collision.
    """
    digest = hashlib.sha256(f"{seed}\n{member_did}".encode("utf-8")).digest()
    return digest, member_did


def select_panel(
    seed: str,
    candidates: Iterable[str],
    size: int = PANEL_SIZE,
) -> tuple[str, ...]:
    """Choose up to ``size`` members of ``candidates`` for ``seed``.

    Pure and deterministic: the result depends only on the seed and on *which*
    DIDs are candidates, not on their order or on duplicates.  Fewer than
    ``size`` candidates yields all of them; the caller decides whether that is
    enough.
    """
    ranked = sorted(set(candidates), key=lambda did: seat_rank(seed, did))
    return tuple(ranked[:size])


# --------------------------------------------------------------------------- #
# Who is eligible
# --------------------------------------------------------------------------- #


def _tiered_dids() -> list[str]:
    """Every DID whose account is at a panel tier."""
    ensure_account_table()
    with db.SessionLocal() as session:
        rows = session.query(Account.did).filter(Account.tier.in_(PANEL_TIERS)).all()
    return [str(did) for (did,) in rows]


def eligible_members(excluded: Collection[str] = ()) -> list[str]:
    """The tier-3 and tier-4 members who are not in ``excluded``, sorted."""
    barred = set(excluded)
    return sorted(did for did in _tiered_dids() if did not in barred)


# --------------------------------------------------------------------------- #
# Reading a saved panel
# --------------------------------------------------------------------------- #


def panel_seed(appeal_cid: object) -> str:
    """The seed the panel of ``appeal_cid`` is drawn from.

    The value stored on the appeal's row when it has one (see
    :mod:`app.modules.appeals.service`): :func:`derive_panel_seed` of the
    appealed decision, fixed before the panel is drawn, so neither the appellant
    nor the deciding moderator can grind the draw.  An appeal whose seed has not
    been stored -- one drawn before seeds were kept -- is ordered by its
    decision's cid, and a cid this node has no row for by itself, so a direct
    :func:`draw_panel` call still gets a stable seed.  :func:`~.service.seat_panel`
    never draws from the fallback.
    """
    if not isinstance(appeal_cid, str) or not appeal_cid:
        return ""
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(Appeal, appeal_cid)
        if row is not None:
            for attr in ("panel_seed", "seed", "draw_seed"):
                value = getattr(row, attr, None)
                if isinstance(value, str) and value:
                    return value
            if isinstance(row.decision_cid, str) and row.decision_cid:
                return str(row.decision_cid)
    return appeal_cid


def get_panel(appeal_cid: object) -> list[AppealPanelMember]:
    """The members seated for this appeal, in seat order; empty if no panel is drawn."""
    if not isinstance(appeal_cid, str) or not appeal_cid:
        return []
    ensure_tables()
    with db.SessionLocal() as session:
        rows = session.query(AppealPanelMember).filter(AppealPanelMember.appeal_cid == appeal_cid).all()
        session.expunge_all()
    seed = panel_seed(appeal_cid)
    return sorted(rows, key=lambda row: seat_rank(seed, str(row.member_did)))


# --------------------------------------------------------------------------- #
# Saving the panel
# --------------------------------------------------------------------------- #


def draw_panel(
    appeal_cid: str,
    *,
    excluded: Collection[str] = (),
    seed: Optional[str] = None,
) -> list[AppealPanelMember]:
    """Save the panel for ``appeal_cid`` to ``appeal_panels``; return its seats.

    Idempotent: an appeal that has a panel gets that panel back, untouched,
    however the membership has changed since.  ``excluded`` is every DID that
    must not sit -- the deciding moderator and the paper's authors.  ``seed`` is
    the appeal's panel seed; it defaults to :func:`panel_seed`, so a direct
    call for an unsaved cid seeds from that cid and still agrees with
    :func:`get_panel`.

    Raises:
        PanelUnavailable: ``503`` -- fewer than :data:`PANEL_SIZE` eligible
            members.  Nothing is saved.
    """
    ensure_tables()
    if seed is None:
        seed = panel_seed(appeal_cid)
    with _draw_lock:
        existing = get_panel(appeal_cid)
        if existing:
            return existing

        pool = eligible_members(excluded)
        if len(pool) < PANEL_SIZE:
            raise PanelUnavailable(appeal_cid, eligible=len(pool), needed=PANEL_SIZE)

        with db.SessionLocal() as session:
            session.add_all(
                AppealPanelMember(appeal_cid=appeal_cid, member_did=did, vote=None)
                for did in select_panel(seed, pool)
            )
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                # Another process seated this panel between the check above and
                # now; its rows are the panel.
                seated: Optional[list[AppealPanelMember]] = get_panel(appeal_cid)
                if not seated:
                    raise
                return seated
        return get_panel(appeal_cid)
