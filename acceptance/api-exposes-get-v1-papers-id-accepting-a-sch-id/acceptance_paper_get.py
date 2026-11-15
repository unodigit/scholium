"""Acceptance tests for: API exposes GET /v1/papers/{id} accepting a ``sch:`` id,
a ``sch:`` version id or a version cid, and returning title, abstract, authors,
categories, licence, status, notices and version n (catalog plugin, feature 79).

Criteria (app_spec.xml, feature 79):

* GET /v1/papers/sch:xxxx-xxxx-xxxx for a listed paper returns 200 with the
  latest version.
* GET /v1/papers/sch:xxxx-xxxx-xxxx/v1 returns version 1 after version 2 is
  listed.
* GET /v1/papers/{id} for an unlisted draft returns 404 to anonymous readers.

The first three tests below are those criteria, one each.  The last two cover
the rest of the feature line -- addressing a version by its cid, and the fields
the response carries -- and assert nothing beyond it.

How the scene is set up
-----------------------

The papers and their versions belong to the submissions plugin, whose
``POST /v1/records`` handlers are guarded by tier, endorsement, consent and
moderation rules that have nothing to do with reading a paper back.  So the
scene is put in place the way the sibling suites do it:

* a ``paper.genesis``, a ``manifest`` and one ``paper.version`` record per
  version, each correctly signed and appended to the event log;
* the paper and its versions indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make --
  so ``papers``, ``paper_versions`` and ``authorship`` hold them, a version
  starting in ``awaiting_consent``;
* a version is *listed* with the plugin's exported ``transition_version``
  (``scanning`` -> ``moderation`` -> ``listed``), which is what a moderator's
  decision ends up calling: it stamps ``listed_at`` and points the paper's
  ``latest_version_cid`` at the version.

Everything the criteria are about goes through the public surface: an
anonymous ``GET /v1/papers/{id}``.

Reading the response
--------------------

The criteria fix *which version* the response describes and *that* it carries
the named fields; they do not fix the JSON layout.  The helpers below therefore
read ``title`` and the version number wherever a reasonable layout puts them --
at the top level or inside one nested object (``version``, ``paper``, ...) --
and every version in a scene gets a title of its own, so the answer is
identified by what the response says and never by the shape around it.

Why the 404 test also expects a 200
-----------------------------------

Before the feature exists *every* ``GET /v1/papers/...`` is a 404, because no
route matches.  A test that only expected 404 would pass on an empty project and
prove nothing.  So the unlisted-draft test first reads a *listed* paper from the
same node (which must be 200) and only then checks that the unlisted ones are
refused.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, NamedTuple, Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    validate_envelope,
    verify_record,
)

from app.modules import ledger
from app.modules.submissions import (
    AWAITING_CONSENT,
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

PAPERS_URL = "/v1/papers"

#: The states a version walks through on its way to being listed.
_TO_LISTED = ("scanning", "moderation", "listed")


# --------------------------------------------------------------------------- #
# The scene: papers whose versions are, or are not, listed
# --------------------------------------------------------------------------- #


class Version(NamedTuple):
    """One version of a scene paper, with what a response must say about it."""

    n: int
    cid: str
    title: str
    abstract: str


class ScenePaper:
    """A paper started by a ``paper.genesis`` whose versions the test adds one by one.

    Starting a paper leaves it unlisted: it has a ``papers`` row and a genesis
    in the log, no version, and nothing listed.  :meth:`add_version` stores the
    next version (in ``awaiting_consent``, or in another state when asked) and
    :meth:`list_version` lists one.
    """

    def __init__(
        self,
        *,
        categories: tuple[str, ...] = ("cs.CR",),
        licence: str = "CC-BY-4.0",
        author_count: int = 2,
    ) -> None:
        self.tag = uuid.uuid4().hex
        self.categories = list(categories)
        self.licence = licence
        self._keys = [SigningKey.generate() for _ in range(author_count)]
        #: The listed authors' DIDs, in byline order.
        self.author_dids = [did_key_from_signing_key(key) for key in self._keys]
        self.versions: list[Version] = []

        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Acceptance paper {self.tag}",
                "abstract": "A paper readers look up in the catalog.",
                "categories": self.categories,
                "licence": self.licence,
                "authors": self.author_dids,
            },
        )
        ledger.append(self.genesis)
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
            licence=self.licence,
        )
        #: The ``sch:xxxx-xxxx-xxxx`` id of the paper.
        self.short_id = derive_short_id(self.genesis["id"])

    # -- signing --------------------------------------------------------- #

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        """A complete record signed by the lead author: ``id`` is the recomputed cid."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.author_dids[0],
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self._keys[0],
        )
        # Guard the fixture itself: a failure further on can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record

    # -- versions -------------------------------------------------------- #

    def add_version(self, state: str = AWAITING_CONSENT) -> Version:
        """Store the paper's next version; leave it in ``state`` (never listed here).

        ``state`` is ``awaiting_consent`` (a fresh version) or another unlisted
        state such as ``draft``.  Use :meth:`list_version` to list it.
        """
        n = len(self.versions) + 1
        prev = self.versions[-1].cid if self.versions else self.genesis["id"]
        title = f"Acceptance paper {self.tag} -- version {n}"
        abstract = f"What changed in version {n} of paper {self.tag}."
        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag} v{n}".encode()

        manifest = self._sign(
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
        record = self._sign(
            "paper.version",
            {
                "paper": self.genesis["id"],
                "n": n,
                "title": title,
                "abstract": abstract,
                "authors": [
                    {
                        "did": did,
                        "position": index + 1,
                        "creditRoles": ["Conceptualization"],
                    }
                    for index, did in enumerate(self.author_dids)
                ],
                "manifest": manifest["id"],
                "licence": self.licence,
                "changeNote": f"Version {n}.",
            },
            prev=prev,
        )
        ledger.append(manifest)
        ledger.append(record)
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract=abstract,
            manifest_cid=manifest["id"],
            licence=self.licence,
            prev_cid=prev,
            change_note=f"Version {n}.",
            authors=tuple(
                VersionAuthor(did, index + 1, ("Conceptualization",))
                for index, did in enumerate(self.author_dids)
            ),
        )
        version = Version(n=n, cid=record["id"], title=title, abstract=abstract)
        self.versions.append(version)
        if state != AWAITING_CONSENT:
            transition_version(version.cid, state)
        return version

    def list_version(self, version: Version) -> None:
        """Take ``version`` through scanning and moderation to ``listed``."""
        for state in _TO_LISTED:
            transition_version(version.cid, state)

    def listed(self, versions: int = 1) -> "ScenePaper":
        """Add ``versions`` versions and list each in turn; return ``self``."""
        for _ in range(versions):
            self.list_version(self.add_version())
        return self

    # -- the ids a reader can use ---------------------------------------- #

    def short_version_id(self, n: int) -> str:
        """``sch:xxxx-xxxx-xxxx/vN``."""
        return f"{self.short_id}/v{n}"


# --------------------------------------------------------------------------- #
# Reading a response
# --------------------------------------------------------------------------- #


def _scopes(body: Any) -> list[dict]:
    """The response object followed by every object nested directly inside it."""
    if not isinstance(body, dict):
        return []
    return [body] + [value for value in body.values() if isinstance(value, dict)]


def _field(body: Any, name: str) -> Any:
    """``name`` at the top of the response, else inside one nested object, else ``None``."""
    for scope in _scopes(body):
        if name in scope:
            return scope[name]
    return None


def _has_field(body: Any, name: str) -> bool:
    return any(name in scope for scope in _scopes(body))


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _version_number(body: Any) -> Optional[int]:
    """The version number the response describes, or ``None`` when it names none."""
    for scope in _scopes(body):
        for key in ("n", "version_n", "versionN", "version_number", "versionNumber"):
            if _is_int(scope.get(key)):
                return scope[key]
        if _is_int(scope.get("version")):
            return scope["version"]
    return None


def _get(client, ident: str):
    """``GET /v1/papers/{ident}`` as an anonymous reader."""
    return client.get(f"{PAPERS_URL}/{ident}")


def _ok(client, ident: str) -> dict:
    """``GET /v1/papers/{ident}`` -- must answer 200; return its JSON body."""
    response = _get(client, ident)
    assert response.status_code == 200, (
        f"GET {PAPERS_URL}/{ident} -> {response.status_code}: {response.text}"
    )
    return response.json()


def _assert_describes(body: dict, version: Version) -> None:
    """The response is about ``version``: its number and its title."""
    assert _version_number(body) == version.n, (
        f"expected version {version.n}, response names {_version_number(body)!r}: {body}"
    )
    assert _field(body, "title") == version.title, (
        f"expected the title of version {version.n} ({version.title!r}): {body}"
    )


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_listed_paper_by_short_id_returns_200_with_the_latest_version(client):
    """GET /v1/papers/sch:xxxx-xxxx-xxxx for a listed paper returns 200 with the latest version."""
    paper = ScenePaper()
    v1 = paper.add_version()
    paper.list_version(v1)

    # Listed with one version: that version is the latest.
    _assert_describes(_ok(client, paper.short_id), v1)

    # A newer version is listed: the paper now reads as that one.
    v2 = paper.add_version()
    paper.list_version(v2)
    _assert_describes(_ok(client, paper.short_id), v2)


def test_short_version_id_returns_version_1_after_version_2_is_listed(client):
    """GET /v1/papers/sch:xxxx-xxxx-xxxx/v1 returns version 1 after version 2 is listed."""
    paper = ScenePaper()
    v1 = paper.add_version()
    paper.list_version(v1)
    v2 = paper.add_version()
    paper.list_version(v2)
    assert [v.n for v in paper.versions] == [1, 2]  # the scene itself

    body = _ok(client, paper.short_version_id(1))

    _assert_describes(body, v1)
    assert _field(body, "title") != v2.title, body


def test_unlisted_draft_returns_404_to_anonymous_readers(client):
    """GET /v1/papers/{id} for an unlisted draft returns 404 to anonymous readers."""
    # The route exists and serves a listed paper to this same anonymous client;
    # without this a 404 below could just mean "no such route".
    listed = ScenePaper().listed()
    assert _get(client, listed.short_id).status_code == 200

    # A version nobody has consented to yet.
    awaiting = ScenePaper()
    awaiting_v1 = awaiting.add_version()
    # A version sent back to draft.
    drafted = ScenePaper()
    drafted_v1 = drafted.add_version(state="draft")
    # A paper that has been started but has no version at all.
    bare = ScenePaper()

    unlisted = {
        "awaiting_consent: sch: id": awaiting.short_id,
        "awaiting_consent: sch: version id": awaiting.short_version_id(1),
        "awaiting_consent: version cid": awaiting_v1.cid,
        "draft: sch: id": drafted.short_id,
        "draft: sch: version id": drafted.short_version_id(1),
        "draft: version cid": drafted_v1.cid,
        "no version: sch: id": bare.short_id,
    }
    statuses = {label: _get(client, ident).status_code for label, ident in unlisted.items()}

    assert statuses == {label: 404 for label in unlisted}, statuses


# --------------------------------------------------------------------------- #
# The rest of the feature line
# --------------------------------------------------------------------------- #


def test_version_cid_returns_that_version(client):
    """A version cid is accepted as the id and returns the version it names."""
    paper = ScenePaper()
    v1 = paper.add_version()
    paper.list_version(v1)
    v2 = paper.add_version()
    paper.list_version(v2)

    _assert_describes(_ok(client, v1.cid), v1)
    _assert_describes(_ok(client, v2.cid), v2)


def test_response_carries_title_abstract_authors_categories_licence_status_notices_and_n(client):
    """The response carries title, abstract, authors, categories, licence, status, notices, n."""
    paper = ScenePaper(categories=("cs.CR", "cs.LG"), licence="CC-BY-4.0", author_count=2)
    version = paper.add_version()
    paper.list_version(version)

    body = _ok(client, paper.short_id)

    for name in ("title", "abstract", "authors", "categories", "licence", "status", "notices"):
        assert _has_field(body, name), f"response has no {name!r}: {body}"
    assert _version_number(body) == 1, body

    assert _field(body, "title") == version.title, body
    assert _field(body, "abstract") == version.abstract, body
    assert sorted(_field(body, "categories")) == sorted(paper.categories), body
    assert _field(body, "licence") == paper.licence, body
    assert isinstance(_field(body, "status"), str) and _field(body, "status"), body
    authors = _field(body, "authors")
    assert isinstance(authors, list) and len(authors) == len(paper.author_dids), body
    assert isinstance(_field(body, "notices"), list), body
