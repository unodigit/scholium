"""Acceptance tests for: API exposes GET /v1/papers/{id}/v/{n}/annotations (feature 104).

An annotation is a client-signed ``discussion.post`` record whose anchor names
a version cid, a ``paragraph_id``, a ``quote`` and an ``offset``
(``POST /v1/annotations``, feature 103).  ``GET /v1/papers/{id}/v/{n}/annotations``
returns the annotations of version ``n`` of paper ``id`` grouped by
``paragraph_id``, so that after a reload each annotation is attached to the
same paragraph again.

Criterion (app_spec.xml, feature 104):

* An annotation created with paragraph_id P is returned under P by
  GET /v1/papers/{id}/v/{n}/annotations.

How the scene is set up
-----------------------

The paper and its version belong to other features (the submission and catalog
plugins), so they are put in place the same way the sibling suites put records
in the log -- ``ledger.append`` of correctly signed, schema-valid records --
rather than through handlers that later features may guard with tier,
endorsement or consent rules this feature knows nothing about:

* a ``paper.genesis`` record; the paper's ``{id}`` is its ``sch:xxxx-xxxx-xxxx``
  short id, derived from the genesis cid;
* a ``manifest`` record and a ``paper.version`` record (``n`` = 1, ``prev`` =
  the genesis cid, ``body.paper`` = the genesis cid), exactly the shape the
  record core's schemas and ``verify_paper`` expect.

The annotation itself is then created through the public endpoint, ``POST
/v1/annotations``, as a signed ``discussion.post`` by an account that has signed
in.  Nothing here depends on the response shape beyond what "grouped by
paragraph_id" says: the response is searched for the group filed under P
(whether it is an object keyed by paragraph id or a list of per-paragraph
groups), and the annotation is recognised by its record id or by its unique
text or quote.  Records are self-authenticating, so the signed-in account is
the paper's own author, who can see their own paper whatever later features
decide about unlisted papers.
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, NamedTuple

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    encode_signature,
    sign_record,
    validate_envelope,
    verify_record,
)

from app.modules import ledger

#: The endpoint that creates an annotation (feature 103).
ANNOTATIONS_URL = "/v1/annotations"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


def _sign_in(client, seed: SigningKey) -> str:
    """Sign ``seed``'s did:key in (challenge, then verify); return the access token."""
    did = did_key_from_signing_key(seed)
    challenge = client.post("/v1/auth/challenge", json={"did": did})
    assert challenge.status_code == 200, challenge.text
    nonce = challenge.json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verify = client.post(
        "/v1/auth/verify", json={"did": did, "nonce": nonce, "signature": signature}
    )
    assert verify.status_code == 200, verify.text
    return verify.json()["access_token"]


class Published(NamedTuple):
    """A paper with one version, as the public API would address them."""

    short_id: str  #: ``sch:xxxx-xxxx-xxxx`` -- the ``{id}`` of the URL
    n: int  #: the version number -- the ``{n}`` of the URL
    genesis_id: str  #: cid of the ``paper.genesis`` record
    version_id: str  #: cid of the ``paper.version`` record


class Author:
    """A signed-in author who signs records and publishes a paper version."""

    def __init__(self, client) -> None:
        self.client = client
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        token = _sign_in(client, self.seed)
        self.headers = {"Authorization": f"Bearer {token}"}

    def sign(self, record_type: str, body: dict, prev: str | None = None) -> dict:
        """A complete record: ``id`` is the recomputed cid, ``sig`` is this author's."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        # Guard the fixture itself: a failure below can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record

    def publish_version(self) -> Published:
        """Put a paper and its version 1 in the event log; return how to address them."""
        tag = uuid.uuid4().hex
        manuscript = f"%PDF-1.7 acceptance manuscript {tag}".encode()

        genesis = self.sign(
            "paper.genesis",
            {
                "seed": tag,
                "title": f"Acceptance paper {tag}",
                "abstract": "A paper that readers annotate.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        manifest = self.sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": compute_file_id(manuscript),
                        "size": len(manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        version = self.sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": f"Acceptance paper {tag}",
                "abstract": "A paper that readers annotate.",
                "authors": [self.did],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )
        for record in (genesis, manifest, version):
            ledger.append(record)
        return Published(
            short_id=derive_short_id(genesis["id"]),
            n=1,
            genesis_id=genesis["id"],
            version_id=version["id"],
        )


@pytest.fixture
def author(client) -> Author:
    return Author(client)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


class Annotation(NamedTuple):
    """An annotation that was created, with what identifies it in a response."""

    record_id: str
    paragraph_id: str
    quote: str
    text: str

    @property
    def needles(self) -> tuple[str, ...]:
        """Values that identify this annotation wherever a response echoes it.

        The record id is the canonical one; the quote and text are unique to
        the annotation, so a response that echoes only those still identifies
        it without ambiguity.
        """
        return (self.record_id, self.quote, self.text)


def new_paragraph_id() -> str:
    """A paragraph id in the project's form: sha256 hex of a paragraph's text."""
    return hashlib.sha256(f"paragraph {uuid.uuid4().hex}".encode()).hexdigest()


def create_annotation(
    client, author: Author, published: Published, paragraph_id: str
) -> Annotation:
    """Create an annotation on ``paragraph_id`` of the version through ``POST /v1/annotations``."""
    tag = uuid.uuid4().hex
    quote = f"quoted words {tag}"
    text = f"annotation text {tag}"
    record = author.sign(
        "discussion.post",
        {
            "target": published.version_id,
            "paper": published.genesis_id,
            # The anchor names the version cid, paragraph_id, quote and offset;
            # the record schema accepts the version under either key.
            "anchor": {
                "version": published.version_id,
                "versionCid": published.version_id,
                "paragraph_id": paragraph_id,
                "quote": quote,
                "offset": 7,
            },
            "text": text,
            "parent": None,
        },
    )
    response = client.post(ANNOTATIONS_URL, json=record, headers=author.headers)
    assert response.status_code == 201, (
        f"setup: POST {ANNOTATIONS_URL} must accept the annotation: "
        f"{response.status_code} {response.text}"
    )
    return Annotation(
        record_id=record["id"], paragraph_id=paragraph_id, quote=quote, text=text
    )


def get_annotations(client, author: Author, published: Published):
    return client.get(
        f"/v1/papers/{published.short_id}/v/{published.n}/annotations",
        headers=author.headers,
    )


def _walk(node: Any) -> Iterator[Any]:
    """Every value nested in ``node``, ``node`` itself first."""
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def group_filed_under(payload: Any, paragraph_id: str) -> Any:
    """The part of ``payload`` that files annotations under ``paragraph_id``, or ``None``.

    "Grouped by paragraph_id" can be written two ways, and both are accepted:

    * an object keyed by paragraph id -- ``{P: [...]}``, alone or inside a
      wrapper such as ``{"annotations": {P: [...]}}``; the group is the value;
    * a list of group objects tagged with the paragraph id --
      ``[{"paragraph_id": P, "annotations": [...]}]``; the group is the
      list(s) the object holds.

    An annotation that merely carries ``paragraph_id: P`` as a field (a flat
    list) is not a group, so it does not count.
    """
    for node in _walk(payload):
        if not isinstance(node, dict):
            continue
        if paragraph_id in node:
            return node[paragraph_id]
        tagged = paragraph_id in (node.get("paragraph_id"), node.get("paragraphId"))
        lists = [value for value in node.values() if isinstance(value, list)]
        if tagged and lists:
            return lists
    return None


def mentions(group: Any, annotation: Annotation) -> bool:
    """Whether ``group`` holds ``annotation`` (by record id, quote or text)."""
    return any(
        isinstance(leaf, str) and any(needle in leaf for needle in annotation.needles)
        for leaf in _walk(group)
    )


# --------------------------------------------------------------------------- #
# Criterion: an annotation created with paragraph_id P is returned under P
# --------------------------------------------------------------------------- #


def test_annotation_created_with_paragraph_id_p_is_returned_under_p(client, author):
    published = author.publish_version()
    p = new_paragraph_id()
    q = new_paragraph_id()
    assert p != q
    on_p = create_annotation(client, author, published, p)
    # A second paragraph of the same version makes "under P" mean something:
    # the response has to tell the paragraphs apart.
    on_q = create_annotation(client, author, published, q)

    response = get_annotations(client, author, published)

    assert response.status_code == 200, response.text
    payload = response.json()

    under_p = group_filed_under(payload, p)
    assert under_p is not None, (
        f"the response files nothing under paragraph_id {p}; got {payload!r}"
    )
    assert mentions(under_p, on_p), (
        f"the annotation created with paragraph_id {p} ({on_p.record_id}) "
        f"is not returned under {p}; that group is {under_p!r}"
    )

    # Grouped, not merely listed: the other paragraph's annotation is filed
    # under that paragraph, not under P.
    under_q = group_filed_under(payload, q)
    assert under_q is not None and mentions(under_q, on_q), (
        f"the annotation created with paragraph_id {q} ({on_q.record_id}) "
        f"is not returned under {q}; got {payload!r}"
    )
    assert not mentions(under_p, on_q), (
        f"the annotation created with paragraph_id {q} is wrongly returned "
        f"under {p}: {under_p!r}"
    )
