"""Acceptance tests for: API exposes GET /v1/papers/{id}/v/{n}/text that returns
the version paragraphs with paragraph_id, position and text for the HTML reading
view (reading plugin, feature 182).

Criterion (app_spec.xml, feature 182):

* GET /v1/papers/{id}/v/{n}/text for a listed version returns 200 with
  paragraphs carrying paragraph_id.

The first test below is that criterion.  The rest cover the feature line -- the
``position`` and ``text`` each paragraph carries, and that ``{n}`` is the version
whose paragraphs come back -- and assert nothing beyond it.

How the scene is set up
-----------------------

The papers and their versions belong to the submissions plugin, whose
``POST /v1/records`` handlers are guarded by tier, endorsement, consent and
moderation rules that have nothing to do with reading a version back.  So the
scene is put in place the way the sibling acceptance suites do it:

* a ``paper.genesis``, a ``manifest`` and one ``paper.version`` record per
  version, each correctly signed and appended to the event log;
* the paper and its versions indexed through the submissions plugin's own
  exported ``save_paper`` / ``save_version`` -- the calls its handlers make --
  so ``papers``, ``paper_versions`` and ``authorship`` hold them;
* a version is *listed* with the plugin's exported ``transition_version``
  (``scanning`` -> ``moderation`` -> ``listed``), which is what a moderator's
  decision ends up calling.

The version's paragraphs come from the automated-checks plugin (feature 65),
which owns the ``version_texts`` table and assigns each paragraph its stable id
(sha256 of the normalized text) and its position --
``checks.save_paragraphs(version_cid, texts)``.  Nothing here writes a
``version_texts`` row by hand or invents a paragraph id.

Everything the criteria are about goes through the public surface: an anonymous
``GET /v1/papers/{id}/v/{n}/text``.

Reading the response
--------------------

The criterion fixes that the response is 200 and that its paragraphs carry
``paragraph_id``; the feature line adds ``position`` and ``text``.  They do not
fix the JSON layout, so the helpers below find paragraph objects wherever the
response nests them and read each field under its document name (the project's
usual camel-case spelling of ``paragraph_id`` is accepted too).  Every paragraph
in a scene has unique text, so a paragraph is recognised by the id the checks
plugin gave it and never by the shape around it.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterator, NamedTuple, Optional

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

from app.modules import checks, ledger
from app.modules.submissions import (
    save_paper,
    save_version,
    transition_version,
)

#: The states a version walks through on its way to being listed.
_TO_LISTED = ("scanning", "moderation", "listed")

#: Paragraph fields, under their document name and the project's camel-case
#: alias (the annotations endpoint spells ``paragraph_id`` both ways).
_PARAGRAPH_ID_KEYS = ("paragraph_id", "paragraphId")


# --------------------------------------------------------------------------- #
# The scene: a paper version that is listed and has extracted text
# --------------------------------------------------------------------------- #


class Version(NamedTuple):
    """One version of a scene paper."""

    n: int  #: the version number -- the ``{n}`` of the URL
    cid: str  #: cid of the ``paper.version`` record


class ScenePaper:
    """A paper started by a ``paper.genesis`` whose versions the test adds one by one."""

    def __init__(self) -> None:
        self.tag = uuid.uuid4().hex
        self._key = SigningKey.generate()
        self.author_did = did_key_from_signing_key(self._key)

        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Acceptance reading paper {self.tag}",
                "abstract": "A paper whose version text readers view as HTML.",
                "categories": ["cs.CR"],
                "licence": "CC-BY-4.0",
                "authors": [self.author_did],
            },
        )
        ledger.append(self.genesis)
        save_paper(
            paper_cid=self.genesis["id"],
            categories=("cs.CR",),
            licence="CC-BY-4.0",
        )
        #: The ``sch:xxxx-xxxx-xxxx`` id of the paper -- the ``{id}`` of the URL.
        self.short_id = derive_short_id(self.genesis["id"])
        self.versions: list[Version] = []

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        """A complete record signed by the author: ``id`` is the recomputed cid."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.author_did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self._key,
        )
        # Guard the fixture itself: a failure further on can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record

    def add_version(self) -> Version:
        """Store the paper's next version (in ``awaiting_consent``) and return it."""
        n = len(self.versions) + 1
        prev = self.versions[-1].cid if self.versions else self.genesis["id"]
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
                "title": f"Acceptance reading paper {self.tag} -- version {n}",
                "abstract": f"What version {n} of paper {self.tag} is about.",
                "authors": [self.author_did],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
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
            title=f"Acceptance reading paper {self.tag} -- version {n}",
            abstract=f"What version {n} of paper {self.tag} is about.",
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=prev,
            change_note=f"Version {n}.",
        )
        version = Version(n=n, cid=record["id"])
        self.versions.append(version)
        return version

    def list_version(self, version: Version) -> None:
        """Take ``version`` through scanning and moderation to ``listed``."""
        for state in _TO_LISTED:
            transition_version(version.cid, state)

    def listed_version(self) -> Version:
        """Add a version and list it; return it."""
        version = self.add_version()
        self.list_version(version)
        return version

    # -- the version's paragraphs --------------------------------------- #

    def save_paragraphs(self, version: Version, texts: list[str]) -> list:
        """Save ``texts`` as ``version``'s paragraphs through the checks plugin.

        Returns the saved ``checks.Paragraph`` rows: each has ``paragraph_id``,
        ``position`` and ``text``.  The plugin -- not this test -- decides the
        ids and positions.
        """
        saved = checks.save_paragraphs(version.cid, texts)
        assert [p.text for p in saved] == texts  # the scene itself
        return saved


def paragraph_texts(count: int) -> list[str]:
    """``count`` unique paragraphs, each a plain sentence of distinct words."""
    tag = uuid.uuid4().hex
    return [f"Paragraph {index} of the acceptance paper {tag}." for index in range(count)]


def get_text(client, paper: ScenePaper, n: int):
    """``GET /v1/papers/{id}/v/{n}/text`` as an anonymous reader."""
    return client.get(f"/v1/papers/{paper.short_id}/v/{n}/text")


# --------------------------------------------------------------------------- #
# Reading the response
# --------------------------------------------------------------------------- #


def _walk(node: Any) -> Iterator[Any]:
    """Every value nested in ``node``, ``node`` itself first."""
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def _paragraph_id(entry: dict) -> Optional[str]:
    """The paragraph id ``entry`` carries, or ``None`` when it carries none."""
    for key in _PARAGRAPH_ID_KEYS:
        value = entry.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def paragraph_entries(payload: Any) -> list[dict]:
    """Every paragraph object in ``payload``, wherever the response nests it."""
    return [
        node
        for node in _walk(payload)
        if isinstance(node, dict) and _paragraph_id(node) is not None
    ]


def entries_by_id(payload: Any) -> dict[str, dict]:
    """The paragraph objects of ``payload`` keyed by the paragraph id they carry."""
    return {_paragraph_id(entry): entry for entry in paragraph_entries(payload)}


def _position(entry: dict) -> Optional[int]:
    value = entry.get("position")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _text(entry: dict) -> Optional[str]:
    value = entry.get("text")
    return value if isinstance(value, str) else None


# --------------------------------------------------------------------------- #
# Criterion
# --------------------------------------------------------------------------- #


def test_listed_version_returns_200_with_paragraphs_carrying_paragraph_id(client):
    """GET /v1/papers/{id}/v/{n}/text for a listed version returns 200 with paragraphs carrying paragraph_id."""
    paper = ScenePaper()
    version = paper.listed_version()
    saved = paper.save_paragraphs(version, paragraph_texts(3))

    response = get_text(client, paper, version.n)

    assert response.status_code == 200, (
        f"GET /v1/papers/{paper.short_id}/v/{version.n}/text -> "
        f"{response.status_code}: {response.text}"
    )
    payload = response.json()

    entries = paragraph_entries(payload)
    assert entries, f"the response carries no paragraph with a paragraph_id: {payload!r}"

    returned = [_paragraph_id(entry) for entry in entries]
    expected = [paragraph.paragraph_id for paragraph in saved]
    assert sorted(returned) == sorted(expected), (
        f"expected the version's paragraphs {sorted(expected)}, "
        f"the response carries {sorted(returned)}: {payload!r}"
    )


# --------------------------------------------------------------------------- #
# The rest of the feature line
# --------------------------------------------------------------------------- #


def test_paragraphs_carry_position_and_text(client):
    """Each returned paragraph carries its position and its text."""
    paper = ScenePaper()
    version = paper.listed_version()
    saved = paper.save_paragraphs(version, paragraph_texts(3))

    response = get_text(client, paper, version.n)
    assert response.status_code == 200, response.text
    by_id = entries_by_id(response.json())

    assert set(by_id) == {paragraph.paragraph_id for paragraph in saved}, by_id
    for paragraph in saved:
        entry = by_id[paragraph.paragraph_id]
        # The text field may be wrapped in HTML for the reading column; the
        # paragraph's own words must be there.
        text = _text(entry)
        assert text is not None and paragraph.text in text, (
            f"paragraph {paragraph.paragraph_id} carries no text {paragraph.text!r}: {entry!r}"
        )
        assert _position(entry) is not None, (
            f"paragraph {paragraph.paragraph_id} carries no position: {entry!r}"
        )

    # Positions order the paragraphs as the checks plugin saved them.
    ordered = [by_id[paragraph.paragraph_id] for paragraph in sorted(saved, key=lambda p: p.position)]
    positions = [_position(entry) for entry in ordered]
    assert positions == sorted(positions), (
        f"positions do not put the paragraphs in reading order: {positions}"
    )
    assert len(set(positions)) == len(positions), f"two paragraphs share a position: {positions}"


def test_n_selects_that_versions_paragraphs(client):
    """GET .../v/{n}/text returns version n's paragraphs, not another version's."""
    paper = ScenePaper()
    v1 = paper.add_version()
    paper.list_version(v1)
    v2 = paper.add_version()
    paper.list_version(v2)
    first = paper.save_paragraphs(v1, paragraph_texts(2))
    second = paper.save_paragraphs(v2, paragraph_texts(3))
    first_ids = {paragraph.paragraph_id for paragraph in first}
    second_ids = {paragraph.paragraph_id for paragraph in second}
    assert first_ids.isdisjoint(second_ids)  # the scene itself

    response = get_text(client, paper, 1)
    assert response.status_code == 200, response.text
    returned = {_paragraph_id(entry) for entry in paragraph_entries(response.json())}
    assert returned == first_ids, (
        f"version 1's text should hold {sorted(first_ids)}, the response holds "
        f"{sorted(returned)}"
    )

    response = get_text(client, paper, 2)
    assert response.status_code == 200, response.text
    returned = {_paragraph_id(entry) for entry in paragraph_entries(response.json())}
    assert returned == second_ids, (
        f"version 2's text should hold {sorted(second_ids)}, the response holds "
        f"{sorted(returned)}"
    )
