"""Discussion posts, threads, helpful votes and mutes (plugin: discussion).

Feature 99: the plugin owns the ``discussion.post`` record type.  An accepted
record is persisted to the ``discussion_posts`` table with

* its cid as ``post_cid``;
* the paper it belongs to as ``paper_cid`` (the paper's genesis cid when the
  node can resolve it, otherwise the record's own ``target``);
* its ``parent_cid`` -- the post being replied to, or ``NULL`` for a thread;
* its ``anchor``;
* its author's DID;
* a ``helpful`` count starting at ``0``.

Persistence happens through a ledger subscriber, so a post is saved whichever
door the record came through (``POST /v1/papers/{id}/threads``,
``POST /v1/records`` or ``POST /v1/annotations``).  :func:`threads_for` also
reconciles the table against the log, so a post appended while no subscriber
was installed is still listed and persisted.

Feature 101: :func:`mark_helpful` records one member's "helpful" mark in
``discussion_helpful_votes`` and increments ``discussion_posts.helpful``.  A
repeat by the same member raises :class:`AlreadyHelpful` (``409``), and so does
a mark by the post's own author (:class:`SelfHelpful`): a member cannot vote
for their own post.  A vote only changes the ordering of a thread -- nothing
here touches ``papers.status``.

Every post is credited to its author's public profile name when one exists
(plugin: profiles, feature 29), with the DID always there as the fallback --
never the other way round.  An erased profile has no name, so its posts show
the pseudonymous DID again.

Feature 102: :func:`mute` remembers that a member mutes another DID, and
:func:`threads_for` omits the muted DID's posts for that member.

Resolution follows the ledger, not the submissions/catalog tables: a paper id
is a one-way digest of its ``paper.genesis`` cid, so it is found by scanning
the event log.  That keeps discussion readable on a node that holds records
without the listing plugins, and matches how the annotations plugin resolves
versions.  Sibling plugins are imported at call time, not module load, so the
module loader may reach this package before them.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from scholium_record_core import derive_short_id, parse_short_id, parse_version_id
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import db

from .models import DiscussionPost, HelpfulVote, Mute, ensure_tables

__all__ = [
    "ALREADY_HELPFUL_TYPE",
    "DISCUSSION_POST_TYPE",
    "PAPER_GENESIS_TYPE",
    "PAPER_VERSION_TYPE",
    "SELF_HELPFUL_TYPE",
    "PaperRef",
    "SelfHelpful",
    "author_name",
    "handle_record",
    "mark_helpful",
    "mute",
    "muted_dids",
    "persist_entry",
    "persist_record",
    "resolve_paper",
    "sync_from_ledger",
    "threads_for",
]

#: The record type this plugin owns.
DISCUSSION_POST_TYPE = "discussion.post"

#: The record type that carries a paper's genesis cid.
PAPER_GENESIS_TYPE = "paper.genesis"

#: The record type that publishes one numbered version of a paper.
PAPER_VERSION_TYPE = "paper.version"

#: Problem-details type URN for a second "helpful" mark by the same member.
ALREADY_HELPFUL_TYPE = "urn:scholium:problem:already-helpful"

#: Problem-details type URN for a member marking their own post helpful.
SELF_HELPFUL_TYPE = "urn:scholium:problem:self-helpful"


class SelfHelpful(Exception):
    """The caller wrote the post: a member cannot mark their own post helpful."""


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _iso(value: Any) -> Optional[str]:
    """Render a stored timestamp as ISO 8601 UTC with a ``Z`` suffix."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value.isoformat(timespec="seconds") + "Z"
    return str(value)


def _body(entry: Any) -> Mapping[str, Any]:
    """The row's record body as a mapping (``{}`` when it is not one)."""
    body = getattr(entry, "body", None)
    return body if isinstance(body, Mapping) else {}


def _ledger_entry(record_cid: Any) -> Any:
    """The event-log row for ``record_cid``, or ``None``."""
    if not isinstance(record_cid, str) or not record_cid:
        return None
    from app.modules import ledger

    return ledger.entry_by_cid(record_cid)


def _record_type(record_cid: Any) -> Optional[str]:
    entry = _ledger_entry(record_cid)
    return None if entry is None else entry.record_type


def author_name(did: Any) -> Optional[str]:
    """The public profile name of ``did``, or ``None`` when there is none.

    Posts are credited to the member's name when they saved one (plugin:
    profiles, feature 29).  An account that never saved a profile, an erased
    profile and an unreadable one all fall back to the DID-only display, and
    none of them may take a whole thread list down: this never raises.
    """
    if not isinstance(did, str) or not did.strip():
        return None
    try:
        from app.modules.profiles import read_profile

        data = read_profile(did)
    except Exception:
        # Profiles is a sibling plugin: absent tables, a corrupt blob or any
        # other failure means "no name to show", never a failed discussion.
        return None
    if data is None or not isinstance(data.name, str):
        return None
    return data.name.strip() or None


# --------------------------------------------------------------------------- #
# Paper resolution
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PaperRef:
    """A paper addressed by the public API's ``{id}``.

    ``paper_cid`` is the paper's genesis cid when the node can resolve the id
    and the raw identifier otherwise.  ``keys`` is every spelling a stored
    ``discussion_posts.paper_cid`` may carry for this paper (genesis cid,
    version cids and the raw identifier), so a post written before the paper
    was fully indexed is still found.  ``known`` is ``False`` when the log
    holds no genesis record for the id.
    """

    paper_cid: str
    short_id: Optional[str]
    keys: frozenset[str]
    known: bool


def _genesis_for_short_id(short_id: str) -> Optional[str]:
    """Return the cid of the ``paper.genesis`` whose short id is ``short_id``."""
    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(EventLog)
                .where(EventLog.record_type == PAPER_GENESIS_TYPE)
                .order_by(EventLog.seq)
            ).scalars()
        )
    for row in rows:
        try:
            if derive_short_id(row.record_cid) == short_id:
                return row.record_cid
        except ValueError:
            continue
    return None


def _version_cids(genesis_cid: str) -> list[str]:
    """The cids of every ``paper.version`` record naming ``genesis_cid``."""
    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(EventLog)
                .where(EventLog.record_type == PAPER_VERSION_TYPE)
                .order_by(EventLog.seq)
            ).scalars()
        )
    return [row.record_cid for row in rows if _body(row).get("paper") == genesis_cid]


def _short_id_of(genesis_cid: str) -> Optional[str]:
    try:
        return derive_short_id(genesis_cid)
    except ValueError:
        return None


def resolve_paper(identifier: object) -> Optional[PaperRef]:
    """Resolve the ``{id}`` of a discussion route to the paper it names.

    Accepts a paper ``sch:`` id, a version id (``sch:.../vN``), a
    ``paper.genesis`` cid or a ``paper.version`` cid.  An id the log does not
    hold is kept verbatim: the discussion surface still works for a node that
    receives a post before the paper record it references, and an unknown id
    reads back as an empty thread list rather than an error.
    """
    if not isinstance(identifier, str):
        return None
    ident = identifier.strip()
    if not ident:
        return None

    # ``sch:xxxx-xxxx-xxxx/vN``
    try:
        version_id = parse_version_id(ident)
    except ValueError:
        version_id = None
    if version_id is not None:
        genesis = _genesis_for_short_id(version_id.short_id)
        if genesis is None:
            return PaperRef(ident, version_id.short_id, frozenset({ident}), False)
        keys = {genesis, ident, *_version_cids(genesis)}
        return PaperRef(genesis, version_id.short_id, frozenset(keys), True)

    # ``sch:xxxx-xxxx-xxxx``
    try:
        short_id = parse_short_id(ident)
    except ValueError:
        short_id = None
    if short_id is not None:
        genesis = _genesis_for_short_id(short_id)
        if genesis is None:
            return PaperRef(ident, short_id, frozenset({ident}), False)
        keys = {genesis, ident, *_version_cids(genesis)}
        return PaperRef(genesis, short_id, frozenset(keys), True)

    # A record cid: the paper genesis itself or one of its versions.
    kind = _record_type(ident)
    if kind == PAPER_GENESIS_TYPE:
        keys = {ident, *_version_cids(ident)}
        return PaperRef(ident, _short_id_of(ident), frozenset(keys), True)
    if kind == PAPER_VERSION_TYPE:
        genesis = _body(_ledger_entry(ident)).get("paper")
        if isinstance(genesis, str) and genesis:
            keys = {genesis, ident, *_version_cids(genesis)}
            return PaperRef(genesis, _short_id_of(genesis), frozenset(keys), True)

    # Not a paper this node knows.  Keep it as its own namespace.
    return PaperRef(ident, None, frozenset({ident}), False)


def _paper_for_cid(record_cid: Any) -> Optional[str]:
    """The genesis cid of the paper a record cid belongs to, if it names one."""
    kind = _record_type(record_cid)
    if kind == PAPER_GENESIS_TYPE:
        return record_cid
    if kind == PAPER_VERSION_TYPE:
        paper = _body(_ledger_entry(record_cid)).get("paper")
        if isinstance(paper, str) and paper:
            return paper
    return None


def _paper_key_for_body(body: Mapping[str, Any]) -> Optional[str]:
    """Best-effort paper key for a ``discussion.post`` body.

    Prefers the body's own ``paper`` member, then resolves ``target`` and
    finally the anchor's version.  Falls back to ``target`` verbatim so the
    ``paper_cid`` column is never empty for a schema-valid record.
    """
    paper = body.get("paper")
    if isinstance(paper, str) and paper:
        resolved = _paper_for_cid(paper)
        if resolved is not None:
            return resolved

    target = body.get("target")
    resolved = _paper_for_cid(target)
    if resolved is not None:
        return resolved

    anchor = body.get("anchor")
    candidates: list[Any] = []
    if isinstance(anchor, str):
        candidates.append(anchor)
    elif isinstance(anchor, Mapping):
        candidates.extend([anchor.get("version"), anchor.get("versionCid")])
    for candidate in candidates:
        resolved = _paper_for_cid(candidate)
        if resolved is not None:
            return resolved

    if isinstance(target, str) and target:
        return target
    if isinstance(paper, str) and paper:
        return paper
    return None


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


def persist_entry(entry: Any, *, paper_key: Optional[str] = None) -> Optional[str]:
    """Persist one ledger entry as a ``discussion_posts`` row.

    Idempotent by ``post_cid``: a row that already exists is left alone except
    that a better ``paper_key`` (the canonical genesis cid) replaces a
    best-effort one.  A concurrent insert from another process is swallowed:
    the other writer's row is the same record.
    """
    post_cid = getattr(entry, "record_cid", None)
    if not isinstance(post_cid, str) or not post_cid:
        return None
    if getattr(entry, "record_type", None) != DISCUSSION_POST_TYPE:
        return None

    body = _body(entry)
    author_did = getattr(entry, "author_did", None)
    if not isinstance(author_did, str) or not author_did:
        author_did = body.get("author") if isinstance(body.get("author"), str) else ""

    parent = body.get("parent")
    parent_cid = parent if isinstance(parent, str) and parent else None
    anchor = body.get("anchor")
    key = paper_key or _paper_key_for_body(body)
    if not key:
        return None

    ensure_tables()
    with db.SessionLocal() as session:
        try:
            row = session.get(DiscussionPost, post_cid)
            if row is None:
                session.add(
                    DiscussionPost(
                        post_cid=post_cid,
                        paper_cid=key,
                        parent_cid=parent_cid,
                        anchor=anchor,
                        author_did=author_did,
                        helpful=0,
                    )
                )
            elif paper_key and row.paper_cid != paper_key:
                row.paper_cid = paper_key
            session.commit()
        except IntegrityError:
            session.rollback()
    return post_cid


def persist_record(record: Mapping[str, Any], *, paper_key: Optional[str] = None) -> Optional[str]:
    """Persist an already-accepted record by looking its ledger row up."""
    record_id = record.get("id") if isinstance(record, Mapping) else None
    entry = _ledger_entry(record_id)
    if entry is None:
        return None
    return persist_entry(entry, paper_key=paper_key)


def handle_record(record: Mapping[str, Any]) -> str:
    """Ingest handler for ``discussion.post``; persistence is the ledger's job.

    The handler runs before the append, so it must not write the row: a later
    failed append would leave a post that is not in the log.  The ledger
    subscriber registers it after the commit instead.
    """
    return "accepted"


def sync_from_ledger() -> int:
    """Ensure every ``discussion.post`` in the log has a ``discussion_posts`` row.

    Backstops the ledger subscriber: a post accepted while no subscriber was
    installed (or by a writer that appended straight to the log) is persisted
    the first time threads are read.  Returns the number of rows added.
    """
    from app.modules.ledger.models import EventLog, ensure_table

    ensure_table()
    ensure_tables()
    with db.SessionLocal() as session:
        entries = list(
            session.execute(
                select(EventLog)
                .where(EventLog.record_type == DISCUSSION_POST_TYPE)
                .order_by(EventLog.seq)
            ).scalars()
        )
        existing = set(session.execute(select(DiscussionPost.post_cid)).scalars())

    added = 0
    for entry in entries:
        if entry.record_cid in existing:
            continue
        if persist_entry(entry) is not None:
            added += 1
    return added


# --------------------------------------------------------------------------- #
# Reading threads
# --------------------------------------------------------------------------- #


def _created(entry: Any) -> Optional[str]:
    """The signer's ``created`` timestamp, or nothing for a corrupt row."""
    if entry is None:
        return None
    from app.modules.ledger.records import stored_envelope

    try:
        return stored_envelope(entry).created
    except Exception:  # pragma: no cover - the append-only log should never hold corrupt bytes
        return _iso(getattr(entry, "received_at", None))


def _sort_key(item: Mapping[str, Any]) -> tuple[int, str, int]:
    """Thread order: helpful votes first (most helpful first), then time (oldest first).

    The signer's ISO 8601 ``created`` timestamp orders posts; ``seq`` (the
    ledger's arrival order) breaks ties such as posts created in the same
    second.
    """
    helpful = item.get("helpful")
    helpful = helpful if isinstance(helpful, int) else 0
    created = item.get("created")
    created = created if isinstance(created, str) else ""
    seq = item.get("seq")
    seq = seq if isinstance(seq, int) else 0
    return (-helpful, created, seq)


def _post_document(
    row: DiscussionPost, entry: Any, author_name_value: Optional[str] = None
) -> dict[str, Any]:
    """One post in the wire shape, with an empty ``replies`` list."""
    body = _body(entry)
    post_cid = row.post_cid
    author = row.author_did
    parent = row.parent_cid
    return {
        "id": post_cid,
        "cid": post_cid,
        "post_cid": post_cid,
        "postCid": post_cid,
        "author": author,
        "author_did": author,
        "authorDid": author,
        "author_name": author_name_value,
        "authorName": author_name_value,
        "text": body.get("text"),
        "textCid": body.get("textCid"),
        "target": body.get("target"),
        "paper": body.get("paper"),
        "anchor": body.get("anchor", row.anchor),
        "parent": parent,
        "parent_cid": parent,
        "parentCid": parent,
        "helpful": int(row.helpful or 0),
        "created": _created(entry),
        "seq": getattr(entry, "seq", None),
        "replies": [],
    }


def _nest(records: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Arrange posts into threads: roots plus nested ``replies`` lists.

    A post whose ``parent_cid`` names a post that is not part of the thread
    (a mute removed it, or the parent is on another node) is treated as a
    root, so no visible post disappears just because its parent is absent.
    """
    roots: list[dict[str, Any]] = []
    for post in records.values():
        parent_cid = post.get("parent_cid")
        parent = records.get(parent_cid) if isinstance(parent_cid, str) else None
        if parent is None or parent is post:
            roots.append(post)
        else:
            parent["replies"].append(post)

    def _sort_thread(post: dict[str, Any], seen: set[str]) -> None:
        post["replies"].sort(key=_sort_key)
        for reply in post["replies"]:
            if reply["post_cid"] in seen:  # a malformed cycle cannot recurse forever
                continue
            seen.add(reply["post_cid"])
            _sort_thread(reply, seen)

    roots.sort(key=_sort_key)
    seen: set[str] = set()
    for root in roots:
        seen.add(root["post_cid"])
        _sort_thread(root, seen)
    return roots


def threads_for(ref: PaperRef, *, viewer_did: Optional[str] = None) -> dict[str, Any]:
    """Return ``ref``'s threads, replies ordered by helpful votes then time.

    Posts by a DID the viewer has muted are omitted (feature 102); a reply
    whose parent was omitted is shown at the root so its author's post does
    not vanish with the muted parent.  Without a viewer nothing is muted.
    """
    sync_from_ledger()

    from app.modules.ledger.models import EventLog, ensure_table

    keys = set(ref.keys)
    keys.add(ref.paper_cid)
    ensure_table()

    with db.SessionLocal() as session:
        rows = list(
            session.execute(
                select(DiscussionPost)
                .where(DiscussionPost.paper_cid.in_(keys))
                .order_by(DiscussionPost.post_cid)
            ).scalars()
        )
        entries = {
            entry.record_cid: entry
            for entry in session.execute(
                select(EventLog).where(
                    EventLog.record_cid.in_([row.post_cid for row in rows])
                )
            ).scalars()
        }
        muted = muted_dids(viewer_did) if viewer_did else set()
        visible = [row for row in rows if row.author_did not in muted]

        documents: dict[str, dict[str, Any]] = {}
        names: dict[str, Optional[str]] = {}
        for row in visible:
            did = row.author_did or ""
            if did not in names:
                names[did] = author_name(did)
            documents[row.post_cid] = _post_document(
                row, entries.get(row.post_cid), names[did]
            )

    threads = _nest(documents)
    return {
        "paper": ref.short_id or ref.paper_cid,
        "paper_cid": ref.paper_cid,
        "paperCid": ref.paper_cid,
        "count": len(documents),
        "threads": threads,
    }


# --------------------------------------------------------------------------- #
# Helpful votes (feature 101)
# --------------------------------------------------------------------------- #


def mark_helpful(post_cid: str, voter_did: str) -> tuple[Optional[DiscussionPost], bool]:
    """Record one "helpful" mark; return ``(post, created)``.

    ``(None, False)`` when no such post exists.  ``created`` is ``False`` when
    the member had already marked it (and the row is returned unchanged).
    Raises :class:`SelfHelpful` when the caller wrote the post: a member cannot
    mark their own post helpful.
    The vote and the counter move in one transaction, so a crash can never
    leave a vote without its increment.
    """
    if not isinstance(post_cid, str) or not post_cid:
        return None, False
    if not isinstance(voter_did, str) or not voter_did:
        return None, False

    sync_from_ledger()
    ensure_tables()
    with db.SessionLocal() as session:
        row = session.get(DiscussionPost, post_cid)
        if row is None:
            return None, False
        if row.author_did and row.author_did == voter_did:
            # The author's own mark would be a self-vote, refused before any
            # row is written so the count never moves.
            raise SelfHelpful(f"{voter_did} wrote post {post_cid}")
        if session.get(HelpfulVote, (post_cid, voter_did)) is not None:
            session.expunge(row)
            return row, False
        session.add(HelpfulVote(post_cid=post_cid, voter_did=voter_did))
        row.helpful = int(row.helpful or 0) + 1
        try:
            session.commit()
        except IntegrityError:
            # Two simultaneous marks by the same member: the loser's vote is
            # refused and its increment rolled back with it.
            session.rollback()
            row = session.get(DiscussionPost, post_cid)
            if row is None:
                return None, False
            session.expunge(row)
            return row, False
        session.refresh(row)
        session.expunge(row)
        return row, True


# --------------------------------------------------------------------------- #
# Mutes (feature 102)
# --------------------------------------------------------------------------- #


def mute(muter_did: str, muted_did: str) -> bool:
    """Mute ``muted_did`` for ``muter_did``; return whether the row is new."""
    if not isinstance(muter_did, str) or not muter_did:
        raise ValueError("a muter DID is required")
    if not isinstance(muted_did, str) or not muted_did:
        raise ValueError("a DID to mute is required")
    if muter_did == muted_did:
        raise ValueError("a member cannot mute themselves")

    ensure_tables()
    with db.SessionLocal() as session:
        if session.get(Mute, (muter_did, muted_did)) is not None:
            return False
        session.add(Mute(muter_did=muter_did, muted_did=muted_did))
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            return False
    return True


def muted_dids(muter_did: object) -> set[str]:
    """The DIDs ``muter_did`` has muted (empty for a missing/invalid DID)."""
    if not isinstance(muter_did, str) or not muter_did:
        return set()
    ensure_tables()
    with db.SessionLocal() as session:
        return set(
            session.execute(
                select(Mute.muted_did).where(Mute.muter_did == muter_did)
            ).scalars()
        )
