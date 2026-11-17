"""A hidden discussion post reads as a placeholder, never its body.

A moderator's ``hide`` decision withdraws a flagged post from the public read
surfaces while the signed record stays in the log.  ``GET
/v1/papers/{id}/threads`` is one of those surfaces: it must keep the post's
place in the thread (so replies stay nested under it) and its author's
pseudonym, but serve a placeholder -- id, author, ``hidden_at`` and the
decision's reason -- instead of the text.  The tab's post count excludes it.

Isolation: fresh DIDs and unique bodies, like the rest of this module's tests.
"""

from __future__ import annotations

import uuid

from app.modules import ledger, moderation
from app.modules.discussion.tests.test_discussion import (
    Member,
    post,
    publish,
    threads,
)


def _moderator() -> Member:
    return Member(tier=4)


def _hide(member: Member, post_cid: str, reason: str) -> dict:
    """Append a signed hide decision and apply its hiding to ``post_cid``."""
    decision = member.sign(
        "moderation.decision",
        {
            "target": post_cid,
            "action": "hide",
            "clause": "MOD-01",
            "reason": reason,
        },
    )
    ledger.append(decision)
    moderation.hide_target(post_cid, decision["id"])
    return decision


def _find(payload: dict, post_cid: str) -> dict:
    """The post document with ``post_cid``, however deeply nested."""
    for thread in payload["threads"]:
        found = _find_in(thread, post_cid)
        if found is not None:
            return found
    raise AssertionError(f"post {post_cid} is not in the threads payload")


def _find_in(node: dict, post_cid: str) -> dict | None:
    if node.get("post_cid") == post_cid or node.get("id") == post_cid:
        return node
    for reply in node.get("replies", []):
        found = _find_in(reply, post_cid)
        if found is not None:
            return found
    return None


def test_a_hidden_post_is_returned_as_a_placeholder_without_its_text(client):
    author = Member(tier=1)
    replying_author = Member(tier=1)
    paper = publish(author)
    text = f"the hidden body {uuid.uuid4().hex}"
    hidden = post(client, author, paper, text)
    reply = post(client, replying_author, paper, "A reply under the hidden post.", parent=hidden["id"])

    _hide(_moderator(), hidden["id"], "Off-topic and abusive.")

    payload = threads(client, paper)

    document = _find(payload, hidden["id"])
    assert document["hidden"] is True
    assert document["text"] is None
    assert text not in str(payload)
    assert document["author"] == author.did
    assert document["hidden_reason"] == "Off-topic and abusive."
    assert document["hidden_at"] is not None
    # The reply keeps its place under the placeholder, so no visible post is
    # lost with its parent.
    [nested] = document["replies"]
    assert nested["post_cid"] == reply["id"]
    # The tab's count excludes the hidden placeholder.
    assert payload["count"] == 1


def test_a_release_restores_the_post_body(client):
    author = Member(tier=1)
    paper = publish(author)
    text = f"the restored body {uuid.uuid4().hex}"
    hidden = post(client, author, paper, text)
    moderator = _moderator()
    _hide(moderator, hidden["id"], "Wrongly reported.")

    restored = moderator.sign(
        "moderation.decision",
        {
            "target": hidden["id"],
            "action": "release",
            "clause": "MOD-01",
            "reason": "The appeal was upheld.",
        },
    )
    ledger.append(restored)
    assert moderation.unhide_target(hidden["id"]) is True

    payload = threads(client, paper)

    document = _find(payload, hidden["id"])
    assert document["text"] == text
    assert not document.get("hidden")
    assert payload["count"] == 1
