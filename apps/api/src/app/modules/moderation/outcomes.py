"""Words and links for a moderation outcome, shared by every notifier.

A decision closes flags and tells two audiences: the reporters (``flag.decided``)
and the record's author (``moderation.decision``).  Both need the same three
things, written from the target rather than from the record type's internals:

* what kind of thing was decided -- a paper, a discussion post, an inline
  annotation or a review -- so the sentence says "post" where it is a post and
  "paper" where it is a paper;
* the outcome in words, never a raw action or status code -- and, for the
  reporter, which item it was, the category they filed it under (labelled as
  theirs, never as the reason for the outcome) and, when the decision states
  one, the moderator's own note read from the decision record
  ('The post you reported as "Off topic" on "Title" was reviewed and kept.
  Moderator's note: The post is on topic.');
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
    "EXCERPT_LIMIT",
    "REASON_LABELS",
    "author_summary",
    "decision_reason",
    "excerpt",
    "item_link",
    "paper_title",
    "reason_label",
    "report_link",
    "reporter_summary",
    "target_kind",
]

#: How many characters of a flagged post or review a notice quotes.
EXCERPT_LIMIT = 80

#: The words for every reason code a member can report with.  The reporter's
#: panels offer these ids (``paper-discussion``'s ``REPORT_REASONS`` and
#: ``PAPER_REPORT_REASONS``) and the moderation console reads them back through
#: the same labels, so a reporter, a moderator and a notice all say the same
#: thing.  A code not listed here is still shown as a sentence
#: (:func:`reason_label`), never as the bare code.
REASON_LABELS: Mapping[str, str] = {
    "spam": "Spam or advertising",
    "abuse": "Harassment or abuse",
    "off-topic": "Off topic",
    "misleading": "Misleading or false",
    "legal": "Legal problem",
    "misconduct": "Research misconduct",
    "plagiarism": "Plagiarism",
    "duplicated-figures": "Duplicated figures",
    "other": "Something else",
}

#: Record types this module names, kept as strings so it stays import-light.
_DECISION_TYPE = "moderation.decision"
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


def reason_label(code: Optional[str]) -> str:
    """A reason code in words: ``duplicated-figures`` -> ``Duplicated figures``.

    A code outside :data:`REASON_LABELS` reads as a sentence (``bad_faith`` ->
    ``Bad faith``); a blank one as ``No reason given``.
    """
    text = code.strip() if isinstance(code, str) else ""
    if not text:
        return "No reason given"
    known = REASON_LABELS.get(text.lower().replace("_", "-"))
    if known is not None:
        return known
    words = " ".join(text.replace("_", " ").replace("-", " ").split())
    return words[:1].upper() + words[1:]


def paper_title(target: str) -> Optional[str]:
    """The title of the paper ``target`` is, or belongs to, when this node holds it."""
    try:
        from app.modules import submissions

        version = submissions.get_version(target)
        title = getattr(version, "title", None) if version is not None else None
        if isinstance(title, str) and title.strip():
            return title.strip()
        paper_cid = _paper_cid(target)
        if paper_cid is None:
            return None
        named = _body(_entry(paper_cid)).get("title")
        if isinstance(named, str) and named.strip():
            return named.strip()
        paper = submissions.get_paper(paper_cid)
        latest = getattr(paper, "latest_version_cid", None) if paper is not None else None
        version = submissions.get_version(latest) if isinstance(latest, str) and latest else None
        title = getattr(version, "title", None) if version is not None else None
        if isinstance(title, str) and title.strip():
            return title.strip()
    except Exception:  # pragma: no cover - a title is never worth failing a notice
        return None
    return None


def excerpt(target: str, limit: int = EXCERPT_LIMIT) -> Optional[str]:
    """The first ``limit`` characters of the post or review ``target`` names.

    White space is collapsed to single spaces, and ``...`` marks a cut.  A
    paper has no excerpt -- its title says which it is -- nor does a record this
    node cannot read.
    """
    entry = _entry(target)
    record_type = getattr(entry, "record_type", None)
    body = _body(entry)
    if record_type == _DISCUSSION_POST:
        text = body.get("text")
    elif record_type == _REVIEW_FORMAL:
        text = body.get("report")
    else:
        return None
    if not isinstance(text, str):
        return None
    flat = " ".join(text.split())
    if not flat:
        return None
    if len(flat) <= limit:
        return flat
    return f"{flat[:limit].rstrip()}..."


def _reporter_outcome(kind: str, action: Optional[str]) -> str:
    """What happened to the reported item, as a predicate: ``was hidden``."""
    if action == "hide":
        return "was hidden"
    if action == "dismiss":
        # A dismissed paper flag keeps the paper listed; the words say that
        # rather than leaving "was reviewed and kept" to be read as a reason.
        return "was reviewed and kept listed" if kind == "paper" else "was reviewed and kept"
    if kind == "paper":
        return {
            "list": "was kept listed",
            "hold": "was put on hold",
            "reject": "was rejected",
            "delist": "was delisted",
            "tombstone": "was removed",
            "release": "was restored",
        }.get(action or "", "was reviewed")
    return "was reviewed"


def decision_reason(decision_cid: Optional[str]) -> Optional[str]:
    """The moderator's stated reason in the decision record, when readable.

    The reason stays in the signed record rather than in the projection table,
    so this reads the ledger entry by its cid.  A decision that names a
    ``reasonCid`` instead of inline text is read through the same path the
    moderation endpoint uses to show it to the author.  Anything this node
    cannot read is ``None`` -- a notice never invents a reason.
    """
    entry = _entry(decision_cid)
    if entry is None:
        return None
    body = _body(entry)
    reason = body.get("reason")
    if isinstance(reason, str) and reason.strip():
        return " ".join(reason.split())
    reason_cid = body.get("reasonCid")
    if isinstance(reason_cid, str) and reason_cid.strip():
        try:
            from app.modules.submissions.notices import read_reason_file

            signer = getattr(entry, "author_did", None)
            text = read_reason_file(_DECISION_TYPE, reason_cid.strip(), signer)
        except Exception:  # pragma: no cover - an unreadable file leaves no note
            return None
        flat = " ".join(text.split())
        return flat or None
    return None


def _moderator_note(decision_cid: Optional[str]) -> Optional[str]:
    """The sentence that follows the outcome, one period at its end."""
    reason = decision_reason(decision_cid)
    if not reason:
        return None
    return reason if reason.endswith((".", "!", "?")) else f"{reason}."


def reporter_summary(
    kind: str,
    action: Optional[str],
    *,
    target: Optional[str] = None,
    reason: Optional[str] = None,
    decision_cid: Optional[str] = None,
) -> str:
    """The reporter's outcome in words: what happened to what they reported.

    With the flag's ``target`` the sentence names the item -- for a post or a
    review, the paper's title -- and with the flag's ``reason`` the category
    the reporter filed it under, labelled as theirs.  ``decision_cid`` names
    the decision record; its own reason becomes the moderator's note, so the
    two can never be read as one::

        The post you reported as "Off topic" on "Title" was reviewed and kept. Moderator's note: The post is on topic.
        The paper you reported as "Duplicated figures" was hidden. Moderator's note: The figures are original.

    Whatever the node cannot read is left out, never replaced by a placeholder.
    """
    noun = _KIND_WORDS.get(kind, "record")
    category = reason_label(reason) if isinstance(reason, str) and reason.strip() else None
    if kind == "paper":
        subject = "The paper you reported"
        if category:
            subject += f' as "{category}"'
        sentence = f"{subject} {_reporter_outcome(kind, action)}."
    else:
        subject = f"The {noun} you reported"
        if category:
            subject += f' as "{category}"'
        title = paper_title(target) if target else None
        if title:
            subject += f' on "{title}"'
        sentence = f"{subject} {_reporter_outcome(kind, action)}."
    note = _moderator_note(decision_cid)
    if note:
        sentence += f" Moderator's note: {note}"
    return sentence


def author_summary(kind: str, action: Optional[str], *, target: Optional[str] = None) -> str:
    """The author's outcome in words: what happened to what they signed."""
    noun = _KIND_WORDS.get(kind, "record")
    if kind == "paper":
        title = paper_title(target) if target else None
        subject = f'"{title}"' if title else None
        named = f"Your paper {subject}" if subject else "Your paper"
        outcome = {
            "list": f"{named} was listed.",
            "hold": f"{named} was put on hold.",
            "reject": f"{named} was rejected.",
            "delist": f"{named} was delisted.",
            "tombstone": f"{named} was removed for legal reasons.",
            "release": f"{named} was restored.",
            "dismiss": (f"The report on your paper {subject} was dismissed; nothing changed." if subject
                       else "The report on your paper was dismissed; nothing changed."),
        }.get(action or "")
        return outcome or f"A moderator made a decision on your paper{(' ' + subject) if subject else ''}."
    title = paper_title(target) if target else None
    quote = excerpt(target) if target else None
    subject = f"The {noun} you wrote"
    if title:
        subject += f' on "{title}"'
    if quote:
        subject += f' ("{quote}")'
    if action == "hide":
        return f"{subject} was hidden by moderation."
    if action == "dismiss":
        return f"{subject} was reviewed and kept."
    return f"A moderator made a decision on your {noun}."
