"""A hidden discussion post reads as a placeholder, never its body.

A moderator's ``hide`` decision withdraws a flagged post from the public read
surfaces while the signed record stays in the log.  ``GET
/v1/papers/{id}/threads`` is one of those surfaces: it must keep the post's
place in the thread (so replies stay nested under it) and its author's
pseudonym, but serve a placeholder -- id, author, ``hidden_at`` and the
decision's reason -- instead of the text.  The post's own author is the one
exception (bug_spec_verify15 D2): their read carries what they wrote under
``own_text`` so they can tell two identically-hidden posts apart, and no other
caller is served it.  The tab's post count excludes the placeholder.

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


def test_the_author_reads_their_own_hidden_text_so_two_placeholders_differ(client):
    """D2: an author may read their own post's text; nobody else gains access.

    Two posts hidden for the same reason are otherwise identical rows, so the
    author cannot tell which one they are appealing.  The author's read carries
    their post verbatim under ``own_text`` (the tab collapses it to an excerpt);
    the public ``text`` field stays empty, as it is for every reader.
    """
    author = Member(tier=1)
    paper = publish(author)
    first = f"the first hidden body {uuid.uuid4().hex}"
    second = f"the second hidden body {uuid.uuid4().hex}"
    one = post(client, author, paper, first)
    two = post(client, author, paper, second)
    moderator = _moderator()
    _hide(moderator, one["id"], "Off-topic and abusive.")
    _hide(moderator, two["id"], "Off-topic and abusive.")

    payload = threads(client, paper, author)

    assert _find(payload, one["id"])["own_text"] == first
    assert _find(payload, two["id"])["own_text"] == second
    # The author's copy is a separate field: a hidden post still has no public body.
    assert _find(payload, one["id"])["text"] is None
    assert _find(payload, two["id"])["text"] is None


def test_a_long_hidden_post_reaches_its_author_in_full(client):
    """The tab shortens it; the node does not, so "Show my post" has all of it."""
    author = Member(tier=1)
    paper = publish(author)
    text = f"{uuid.uuid4().hex} " * 40
    hidden = post(client, author, paper, text.strip())
    _hide(_moderator(), hidden["id"], "Off topic.")

    document = _find(threads(client, paper, author), hidden["id"])

    assert document["own_text"] == text.strip()


def test_only_the_author_reads_a_hidden_posts_body(client):
    """A reader, another member and a moderator who is not the author see none."""
    author = Member(tier=1)
    other = Member(tier=1)
    moderator = _moderator()
    paper = publish(author)
    text = f"the private hidden body {uuid.uuid4().hex}"
    hidden = post(client, author, paper, text)
    _hide(moderator, hidden["id"], "Off-topic and abusive.")

    for viewer in (None, other, moderator):
        payload = threads(client, paper, viewer)
        document = _find(payload, hidden["id"])
        assert document["hidden"] is True
        assert document.get("own_text") is None
        assert document["text"] is None
        assert text not in str(payload)


def test_a_hidden_annotation_is_served_with_its_kind_not_its_anchor(client):
    """D3: the author of a hidden annotation must read "annotation" wording.

    The placeholder withholds the anchor (its ``quote`` is body), so the web
    cannot tell an annotation from a thread post by its anchor once it is
    hidden.  The document says which it was under ``is_annotation`` and
    ``target_kind``, in both spellings, while a hidden thread post keeps the
    plain "post" -- that is what lets the card say "Your annotation was
    hidden: …" and "Show my annotation" where a hidden post says "post".
    """
    author = Member(tier=1)
    paper = publish(author)
    record = author.sign(
        "discussion.post",
        {
            "target": paper.version_id,
            "anchor": {
                "version": paper.version_id,
                "versionCid": paper.version_id,
                "paragraph_id": "p-4",
                "paragraphId": "p-4",
                "quote": "the quoted passage",
                "offset": 12,
            },
            "text": f"the hidden annotation body {uuid.uuid4().hex}",
        },
    )
    response = client.post("/v1/annotations", json=record, headers=author.headers)
    assert response.status_code == 201, response.text
    thread = post(client, author, paper, f"a hidden thread post {uuid.uuid4().hex}")
    moderator = _moderator()
    _hide(moderator, record["id"], "Off topic.")
    _hide(moderator, thread["id"], "Off topic.")

    payload = threads(client, paper, author)

    hidden_annotation = _find(payload, record["id"])
    assert hidden_annotation["anchor"] is None
    assert hidden_annotation["is_annotation"] is True
    assert hidden_annotation["isAnnotation"] is True
    assert hidden_annotation["target_kind"] == "annotation"
    assert hidden_annotation["targetKind"] == "annotation"
    hidden_post = _find(payload, thread["id"])
    assert hidden_post["anchor"] is None
    assert hidden_post["is_annotation"] is False
    assert hidden_post["isAnnotation"] is False
    assert hidden_post["target_kind"] == "post"
    assert hidden_post["targetKind"] == "post"


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
