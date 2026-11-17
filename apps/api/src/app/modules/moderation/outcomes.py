"""Words and links for a moderation outcome, shared by every notifier.

A decision closes flags and tells two audiences: the reporters (``flag.decided``)
and the record's author (``moderation.decision``).  Both need the same three
things, written from the target rather than from the record type's internals:

* what kind of thing was decided -- a paper, a discussion post, an inline
  annotation or a review -- so the sentence says "post" where it is a post and
  "paper" where it is a paper;
* the outcome in words ("The post you reported was hidden", "The paper you
  reported was kept listed"), never a raw action or status code;
* where to open it: the paper page, the paper's Discussion tab (where a hidden
  post's placeholder is), or the reviews tab (where a review lives).

The record types live in the ledger and the paper link is a one-way short id,
so this module reads the log rather than importing the discussion, reviews or
submissions plugins at module load -- siblings are imported at call time.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Optional

__all__ = [
    "author_summary",
    "item_link",
    "report_link",
    "reporter_summary",
    "target_kind",
]

#: Record types this module names, kept as strings so it stays import-light.
_DISCUSSION_POST = "discussion.post"
_PAPER_GENESIS = "paper.genesis"
_PAPER_VERSION = "paper.version"
_REVIEW_FORMAL = "review.formal"

_KIND_WORDS = {
    "post": "post",
    "annotation": "annotation",
    "review": "review",
    "paper": "paper",
    "item": "record",
}


def _entry(target: object):
    from app.modules import ledger

    if not isinstance(target, str) or not target:
        return None
    return ledger.entry_by_cid(target)


def _body(entry) -> Mapping[str, object]:
    body = getattr(entry, "body", None)
    return body if isinstance(body, Mapping) else {}


def target_kind(target: str) -> str:
    """What ``target`` is, in the words the outcome sentences use.

    ``paper`` covers a version and a genesis alike: to a reporter who flagged
    "the paper", the version is the paper.  A ``discussion.post`` whose anchor
    names a paragraph is an annotation, not a thread post.
    """
    entry = _entry(target)
    record_type = getattr(entry, "record_type", None)
    if record_type == _DISCUSSION_POST:
        anchor = _body(entry).get("anchor")
        if isinstance(anchor, Mapping) and (
            anchor.get("paragraph_id") or anchor.get("paragraphId")
        ):
            return "annotation"
        return "post"
    if record_type == _REVIEW_FORMAL:
        return "review"
    if record_type in (_PAPER_GENESIS, _PAPER_VERSION):
        return "paper"
    try:
        from app.modules import submissions

        if submissions.get_version(target) is not None:
            return "paper"
    except Exception:  # pragma: no cover - submissions is a shipped plugin
        pass
    return "item"


def _paper_cid(target: str) -> Optional[str]:
    """The genesis cid of the paper ``target`` belongs to, when it names one."""
    entry = _entry(target)
    record_type = getattr(entry, "record_type", None)
    body = _body(entry)
    if record_type == _PAPER_GENESIS:
        return target
    paper = body.get("paper")
    if isinstance(paper, str) and paper:
        return paper
    # A post or review names its version; the version names the genesis.
    named = body.get("target")
    if isinstance(named, str) and named and named != target:
        named_body = _body(_entry(named))
        nested = named_body.get("paper")
        if isinstance(nested, str) and nested:
            return nested
    try:
        from app.modules import submissions

        version = submissions.get_version(target)
        paper_cid = getattr(version, "paper_cid", None) if version is not None else None
        if isinstance(paper_cid, str) and paper_cid:
            return paper_cid
    except Exception:  # pragma: no cover - submissions is a shipped plugin
        pass
    return None


def _short_id(target: str) -> Optional[str]:
    """The paper's ``sch:`` id, when a genesis cid could be derived from it."""
    paper_cid = _paper_cid(target)
    if paper_cid is None:
        return None
    from scholium_record_core import derive_short_id

    try:
        return derive_short_id(paper_cid)
    except ValueError:
        return None


def item_link(target: str, kind: Optional[str] = None) -> Optional[str]:
    """Where the decided item can be opened, or ``None`` when it cannot be named."""
    kind = kind or target_kind(target)
    short = _short_id(target)
    if kind == "paper":
        return f"/p/{short}" if short else f"/p/{target}"
    if kind in ("post", "annotation"):
        return f"/discussion/{short}" if short else None
    if kind == "review":
        return f"/reviews/{short}" if short else None
    return None


def report_link(target: str, kind: Optional[str] = None) -> Optional[str]:
    """Where a reporter can see what happened to what they flagged."""
    return item_link(target, kind)


def reporter_summary(kind: str, action: Optional[str]) -> str:
    """The reporter's outcome in words: what happened to what they reported."""
    noun = _KIND_WORDS.get(kind, "record")
    if action == "hide":
        return f"The {noun} you reported was hidden."
    if action == "dismiss":
        return f"The {noun} you reported was reviewed and kept."
    if kind == "paper":
        outcome = {
            "list": "was kept listed",
            "hold": "was put on hold",
            "reject": "was rejected",
            "delist": "was delisted",
            "tombstone": "was removed",
            "release": "was restored",
        }.get(action or "")
        if outcome is not None:
            return f"The paper you reported {outcome}."
        return "The paper you reported was reviewed."
    return f"The {noun} you reported was reviewed."


def author_summary(kind: str, action: Optional[str]) -> str:
    """The author's outcome in words: what happened to what they signed."""
    noun = _KIND_WORDS.get(kind, "record")
    if kind == "paper":
        outcome = {
            "list": "Your paper was listed.",
            "hold": "Your paper was put on hold.",
            "reject": "Your paper was rejected.",
            "delist": "Your paper was delisted.",
            "tombstone": "Your paper was removed for legal reasons.",
            "release": "Your paper was restored.",
            "dismiss": "The report on your paper was dismissed; nothing changed.",
        }.get(action or "")
        return outcome or "A moderator made a decision on your paper."
    if action == "hide":
        return f"The {noun} you wrote was hidden by moderation."
    if action == "dismiss":
        return f"The {noun} you wrote was reviewed and kept."
    return f"A moderator made a decision on your {noun}."
