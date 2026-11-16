"""Tests for ``GET /v1/papers/{id}/cite`` (plugin: export, feature 90).

Papers are put in place through the submissions plugin's own ``save_paper`` /
``save_version`` / ``save_notice`` -- the calls its record handlers make -- and
listed with ``transition_version``.  Citations are then read through the public
route with an anonymous client, so what is asserted is the text a reference
manager would import, not the code that built it.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Optional

from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app.modules.export import citation
from app.modules.export.records import ListedPaper
from app.modules.profiles import ProfileData, erase_profile, save_profile
from app.modules.submissions import (
    Paper as ORMPaper,
    PaperVersion,
    VersionAuthor,
    save_notice,
    save_paper,
    save_version,
    transition_version,
)

_TO_LISTED = ("scanning", "moderation", "listed")


class Paper:
    """One paper whose versions this test adds and lists."""

    def __init__(
        self, *, categories=("cs.CR",), status: str = "preprint", co_authors: int = 0
    ) -> None:
        self.tag = uuid.uuid4().hex
        self.categories = list(categories)
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.co_authors = [
            did_key_from_signing_key(SigningKey.generate()) for _ in range(co_authors)
        ]
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"Cite paper {self.tag}",
                "abstract": "A paper someone cites.",
                "categories": self.categories,
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
            licence="CC-BY-4.0",
            status=status,
        )
        self.short_id = derive_short_id(self.genesis["id"])
        self.versions: list[tuple[int, str]] = []

    @property
    def authors(self) -> list[str]:
        return [self.did, *self.co_authors]

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.key,
        )

    def add_version(
        self, *, title: Optional[str] = None, listed_at: Optional[datetime] = None, list_it=True
    ) -> tuple[int, str]:
        n = len(self.versions) + 1
        prev = self.versions[-1][1] if self.versions else self.genesis["id"]
        title = title or f"Cite paper {self.tag} -- version {n}"
        record = self._sign(
            "paper.version",
            {"paper": self.genesis["id"], "n": n, "title": title, "abstract": "What it says."},
            prev=prev,
        )
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract="What it says.",
            manifest_cid="bafkreimanifest",
            licence="CC-BY-4.0",
            prev_cid=prev,
            authors=tuple(
                VersionAuthor(did, position, ("Conceptualization",))
                for position, did in enumerate(self.authors, start=1)
            ),
        )
        version = (n, record["id"])
        self.versions.append(version)
        if list_it:
            for state in _TO_LISTED:
                transition_version(
                    record["id"], state, at=listed_at if state == "listed" else None
                )
        return version

    def add_notice(
        self, kind: str, reason: str, created_at: Optional[datetime] = None
    ) -> None:
        save_notice(
            record_cid=f"bafyreinotice{uuid.uuid4().hex}",
            paper_cid=self.genesis["id"],
            kind=kind,
            reason=reason,
            created_at=created_at or datetime(2025, 3, 4, 10, 30),
        )

    def version_id(self, n: int) -> str:
        return f"{self.short_id}/v{n}"


def cite(client, identifier: str, **params):
    return client.get(f"/v1/papers/{identifier}/cite", params=params)


def entries(bibtex: str) -> list[str]:
    return re.findall(r"^@\w+\{", bibtex, flags=re.MULTILINE)


# --------------------------------------------------------------------------- #
# BibTeX
# --------------------------------------------------------------------------- #


def test_bibtex_names_the_title_authors_year_and_version_id(client):
    paper = Paper(categories=("cs.CR", "cs.AI"), co_authors=1)
    paper.add_version(title="Sound proofs", listed_at=datetime(2024, 5, 17, 12, 0))

    response = cite(client, paper.short_id, format="bibtex")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/x-bibtex; charset=utf-8"
    text = response.text
    assert entries(text) == ["@misc{"]
    assert text.startswith(f"@misc{{{paper.short_id.replace(':', '-')}-v1,")
    assert "title = {{Sound proofs}}," in text
    first, second = paper.authors
    assert f"author = {{{{{first}}} and {{{second}}}}}," in text
    assert "year = {2024}," in text
    assert f"eprint = {{{paper.version_id(1)}}}," in text
    assert "version = {1}," in text
    assert "keywords = {cs.CR, cs.AI}," in text
    assert text.rstrip().endswith("}")
    assert "RETRACTED" not in text.upper()


def test_format_defaults_to_bibtex(client):
    paper = Paper()
    paper.add_version()

    response = cite(client, paper.short_id)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-bibtex")
    assert response.text.startswith("@misc{")


def test_format_is_case_insensitive(client):
    paper = Paper()
    paper.add_version()

    assert cite(client, paper.short_id, format="BibTeX").text.startswith("@misc{")
    assert cite(client, paper.short_id, format="RIS").text.startswith("TY  - ")


def test_bibtex_escapes_latex_and_cannot_open_another_entry(client):
    paper = Paper()
    title = "R&D at 100% of cost_$ #1 {x} ~ ^ \\ }\n@misc{evil, title = {pwned}}"
    paper.add_version(title=title)

    text = cite(client, paper.short_id, format="bibtex").text

    assert entries(text) == ["@misc{"]
    assert "pwned" in text  # kept as inert text, not as a second entry
    # Braces are balanced only because every one in the title was escaped.
    depth = 0
    for index, ch in enumerate(text):
        if text[index - 1 : index] == "\\":
            continue
        depth += {"{": 1, "}": -1}.get(ch, 0)
        assert depth >= 0
    assert depth == 0
    assert r"R\&D at 100\% of cost\_\$ \#1 \{x\}" in text
    assert "\n@misc{evil" not in text


# --------------------------------------------------------------------------- #
# Author names
# --------------------------------------------------------------------------- #


def test_authors_with_profiles_are_cited_by_name(client):
    paper = Paper(co_authors=1)
    paper.add_version(title="Sound proofs")
    first, second = paper.authors
    save_profile(
        first, ProfileData(name="Ada Lovelace", affiliation="", email="ada@example.org")
    )
    save_profile(
        second,
        ProfileData(name="Charles Babbage", affiliation="", email="charles@example.org"),
    )

    bibtex = cite(client, paper.short_id, format="bibtex").text
    ris = cite(client, paper.short_id, format="ris").text

    # The profile's display name, as "Family, Given" -- the form a reference
    # manager parses -- and not the DID.
    assert "author = {Lovelace, Ada and Babbage, Charles}," in bibtex
    assert [line for line in ris.splitlines() if line.startswith("AU  - ")] == [
        "AU  - Lovelace, Ada",
        "AU  - Babbage, Charles",
    ]
    assert first not in bibtex and second not in bibtex
    assert first not in ris and second not in ris


def test_an_author_without_a_profile_is_cited_by_did(client):
    paper = Paper(co_authors=1)
    paper.add_version()
    known, stranger = paper.authors
    save_profile(
        known, ProfileData(name="Ada Lovelace", affiliation="", email="ada@example.org")
    )

    bibtex = cite(client, paper.short_id, format="bibtex").text
    ris = cite(client, paper.short_id, format="ris").text

    assert f"author = {{Lovelace, Ada and {{{stranger}}}}}," in bibtex
    assert [line for line in ris.splitlines() if line.startswith("AU  - ")] == [
        "AU  - Lovelace, Ada",
        f"AU  - {stranger}",
    ]


def test_an_erased_profile_falls_back_to_the_did(client):
    paper = Paper()
    paper.add_version()
    save_profile(
        paper.did,
        ProfileData(name="Ada Lovelace", affiliation="", email="ada@example.org"),
    )
    erase_profile(paper.did)

    bibtex = cite(client, paper.short_id, format="bibtex").text
    ris = cite(client, paper.short_id, format="ris").text

    assert f"author = {{{{{paper.did}}}}}," in bibtex
    assert f"AU  - {paper.did}" in ris.splitlines()


def test_a_single_word_name_is_cited_without_a_comma(client):
    paper = Paper()
    paper.add_version()
    save_profile(
        paper.did, ProfileData(name="Hypatia", affiliation="", email="h@example.org")
    )

    bibtex = cite(client, paper.short_id, format="bibtex").text
    ris = cite(client, paper.short_id, format="ris").text

    assert f"author = {{Hypatia}}," in bibtex
    assert "AU  - Hypatia" in ris.splitlines()


# --------------------------------------------------------------------------- #
# RIS
# --------------------------------------------------------------------------- #


def test_ris_names_the_title_authors_year_and_version_id(client):
    paper = Paper(categories=("cs.CR", "cs.AI"), co_authors=1)
    paper.add_version(title="Sound proofs", listed_at=datetime(2024, 5, 17, 12, 0))

    response = cite(client, paper.short_id, format="ris")

    assert response.status_code == 200
    assert response.headers["content-type"] == (
        "application/x-research-info-systems; charset=utf-8"
    )
    lines = response.text.splitlines()
    assert lines[0] == "TY  - UNPB"
    assert lines[-1] == "ER  - "
    assert f"ID  - {paper.version_id(1)}" in lines
    assert "TI  - Sound proofs" in lines
    assert [line for line in lines if line.startswith("AU  - ")] == [
        f"AU  - {did}" for did in paper.authors
    ]
    assert "PY  - 2024" in lines
    assert "DA  - 2024/05/17/" in lines
    assert "KW  - cs.CR" in lines and "KW  - cs.AI" in lines
    assert "ET  - 1" in lines
    assert not any(line.startswith("N1  - ") for line in lines)


def test_ris_values_cannot_start_another_record(client):
    paper = Paper()
    # Only characters that are valid in XML: this paper stays listed for the rest
    # of the worker's session, and the OAI-PMH harvest serialises every listed
    # title.  Control characters are covered below without touching the database.
    paper.add_version(title="Honest title\r\nER  - \r\nTY  - GEN TI  - forged")

    text = cite(client, paper.short_id, format="ris").text

    lines = text.splitlines()
    assert [line for line in lines if line.startswith("TY  - ")] == ["TY  - UNPB"]
    assert [line for line in lines if line.startswith("ER  - ")] == ["ER  - "]
    assert lines[-1] == "ER  - "
    assert len([line for line in lines if line.startswith("TI  - ")]) == 1


def test_control_characters_are_dropped_from_both_formats():
    # Unsaved rows: nothing here reaches the database.
    paper = ORMPaper(
        paper_cid="bafyreitransient",
        short_id="sch:aaaa-aaaa-aaaa",
        categories=["cs.CR"],
        status="preprint",
    )
    version = PaperVersion(
        version_cid="bafyreitransientv1",
        paper_cid=paper.paper_cid,
        n=1,
        title="Bell\x07 and nul\x00 and esc\x1b[31m and tab\there",
        abstract="",
        manifest_cid="bafkreimanifest",
        licence="CC-BY-4.0",
        state="listed",
    )
    record = ListedPaper(paper=paper, version=version, authors=(), notices=())

    for format_name in ("bibtex", "ris"):
        text = citation.render(record, format_name)
        assert not any(unicodedata.category(ch) == "Cc" for ch in text.replace("\n", ""))
        assert "Bell and nul and esc[31m and tab here" in text
    # No year is invented when the node never recorded a listing instant.
    assert "year" not in citation.render(record, "bibtex")
    assert "PY  -" not in citation.render(record, "ris")
    assert citation.render(record, "bibtex").startswith("@misc{sch-aaaa-aaaa-aaaa-v1,")


# --------------------------------------------------------------------------- #
# Which version is cited
# --------------------------------------------------------------------------- #


def test_a_paper_id_cites_the_latest_listed_version(client):
    paper = Paper()
    paper.add_version(title="First draft")
    paper.add_version(title="Second draft")

    text = cite(client, paper.short_id, format="bibtex").text

    assert "title = {{Second draft}}," in text
    assert f"eprint = {{{paper.version_id(2)}}}," in text


def test_a_version_id_cites_exactly_that_version(client):
    paper = Paper()
    paper.add_version(title="First draft")
    paper.add_version(title="Second draft")

    bibtex = cite(client, paper.version_id(1), format="bibtex")
    ris = cite(client, paper.version_id(1), format="ris")

    assert bibtex.status_code == 200
    assert "title = {{First draft}}," in bibtex.text
    assert f"eprint = {{{paper.version_id(1)}}}," in bibtex.text
    assert f"ID  - {paper.version_id(1)}" in ris.text.splitlines()
    assert "TI  - First draft" in ris.text.splitlines()


def test_a_version_cid_and_the_oai_identifier_name_the_same_paper(client):
    paper = Paper()
    first = paper.add_version(title="First draft")
    paper.add_version(title="Second draft")

    by_cid = cite(client, first[1], format="ris")
    by_oai = cite(client, f"oai:scholium:{paper.short_id}", format="ris")

    assert by_cid.status_code == 200
    assert "TI  - First draft" in by_cid.text.splitlines()
    assert by_oai.status_code == 200
    assert "TI  - Second draft" in by_oai.text.splitlines()


def test_a_citation_names_the_version_it_describes_even_when_a_newer_one_is_unlisted(client):
    paper = Paper()
    paper.add_version(title="Published")
    paper.add_version(title="Still in review", list_it=False)

    text = cite(client, paper.short_id, format="bibtex").text

    assert "title = {{Published}}," in text
    assert "Still in review" not in text


# --------------------------------------------------------------------------- #
# Retraction
# --------------------------------------------------------------------------- #


def test_a_retraction_notice_adds_a_note_to_both_formats(client):
    paper = Paper()
    paper.add_version()
    paper.add_notice(
        "retraction", "The dataset was mislabelled.", created_at=datetime(2025, 3, 4, 10, 30)
    )
    expected = (
        "RETRACTED: this paper has been retracted. "
        "Notice of 2025-03-04: The dataset was mislabelled."
    )

    bibtex = cite(client, paper.short_id, format="bibtex").text
    ris = cite(client, paper.short_id, format="ris").text

    assert f"note = {{{expected}}}," in bibtex
    assert f"N1  - {expected}" in ris.splitlines()


def test_a_retraction_posted_through_ingest_is_cited(client):
    """The real path: signed records in, ``POST /v1/records`` accepts them, readers cite.

    Accepting a notice saves a ``notices`` row and does not touch ``papers.status``
    (the submissions tests pin that), so the citation must find the retraction in
    the notice -- which is why it reads both signals.  The helpers are the
    submissions plugin's own, so the records here are exactly what it accepts.
    """
    from app.modules.submissions.tests.test_notices import (
        Account_,
        notice,
        post,
        publish_paper,
        publish_version,
    )

    author = Account_()
    paper_cid = publish_paper(client, author)
    version = publish_version(client, author, paper_cid, 1, [author.did])
    for state in _TO_LISTED:
        transition_version(version["id"], state)
    short_id = derive_short_id(paper_cid)

    before = cite(client, short_id, format="bibtex")
    assert before.status_code == 200
    assert "retract" not in before.text.lower()

    reason = "Images in Figure 2 were duplicated."
    assert post(client, notice(author, "retraction", paper_cid, reason=reason)).status_code == 201

    for format_name in ("bibtex", "ris"):
        after = cite(client, short_id, format=format_name)
        assert after.status_code == 200
        assert "RETRACTED: this paper has been retracted." in after.text
        assert reason in after.text
        assert f"{short_id}/v1" in after.text


def test_a_retracted_status_adds_a_note_even_without_a_notice_row(client):
    paper = Paper(status="retracted")
    paper.add_version()

    bibtex = cite(client, paper.short_id, format="bibtex").text
    ris = cite(client, paper.short_id, format="ris").text

    assert "note = {RETRACTED: this paper has been retracted.}," in bibtex
    assert "N1  - RETRACTED: this paper has been retracted." in ris.splitlines()


def test_every_version_of_a_retracted_paper_carries_the_note(client):
    paper = Paper()
    paper.add_version(title="First draft")
    paper.add_version(title="Second draft")
    paper.add_notice("retraction", "Results do not replicate.")

    first = cite(client, paper.version_id(1), format="bibtex").text
    second = cite(client, paper.version_id(2), format="bibtex").text

    assert "Results do not replicate." in first
    assert "Results do not replicate." in second


def test_every_retraction_notice_is_quoted(client):
    paper = Paper()
    paper.add_version()
    paper.add_notice("retraction", "First reason.", created_at=datetime(2025, 1, 2))
    paper.add_notice("retraction", "Second reason.", created_at=datetime(2025, 6, 7))

    text = cite(client, paper.short_id, format="ris").text

    assert text.count("N1  - ") == 1
    assert "Notice of 2025-01-02: First reason. Notice of 2025-06-07: Second reason." in text


def test_a_correction_or_withdrawal_is_not_a_retraction(client):
    paper = Paper()
    paper.add_version()
    paper.add_notice("correction", "A figure label was wrong.")
    paper.add_notice("withdrawal", "The authors took it back.")

    for format_name in ("bibtex", "ris"):
        text = cite(client, paper.short_id, format=format_name).text
        assert "retract" not in text.lower()
        assert "figure label" not in text


def test_a_retraction_reason_cannot_break_out_of_its_field(client):
    paper = Paper()
    paper.add_version()
    paper.add_notice("retraction", "Bad.}\n@misc{evil, title = {x}}\r\nER  - \r\nTY  - GEN")

    bibtex = cite(client, paper.short_id, format="bibtex").text
    ris = cite(client, paper.short_id, format="ris").text

    assert entries(bibtex) == ["@misc{"]
    lines = ris.splitlines()
    assert [line for line in lines if line.startswith("TY  - ")] == ["TY  - UNPB"]
    assert [line for line in lines if line.startswith("ER  - ")] == ["ER  - "]
    assert lines[-1] == "ER  - "


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


def test_an_unsupported_format_is_a_422_problem(client):
    paper = Paper()
    paper.add_version()

    response = cite(client, paper.short_id, format="endnote")

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 422
    assert body["type"] == "urn:scholium:problem:unsupported-citation-format"
    assert "'bibtex'" in body["detail"] and "'ris'" in body["detail"]


def test_an_empty_format_is_a_422_problem(client):
    paper = Paper()
    paper.add_version()

    assert cite(client, paper.short_id, format="").status_code == 422


def test_an_unknown_paper_is_a_404_problem(client):
    stranger = Paper()  # exists, but its id below is for a different, unsaved genesis

    response = cite(client, "sch:aaaa-aaaa-aaaa", format="bibtex")

    assert stranger.short_id != "sch:aaaa-aaaa-aaaa"
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 404
    assert body["type"] == "urn:scholium:problem:paper-not-found"


def test_malformed_ids_are_404s(client):
    for identifier in ("nonsense", "sch:not-an-id", "sch:aaaa-aaaa-aaaa/v0", "a/b/c/d"):
        for format_name in ("bibtex", "ris"):
            response = cite(client, identifier, format=format_name)
            assert response.status_code == 404, identifier


def test_an_unlisted_paper_or_version_is_indistinguishable_from_unknown(client):
    unlisted = Paper()
    unlisted.add_version(list_it=False)
    partly = Paper()
    partly.add_version(title="Listed")
    partly.add_version(title="Unlisted", list_it=False)

    assert cite(client, unlisted.short_id).status_code == 404
    assert cite(client, unlisted.version_id(1)).status_code == 404
    assert cite(client, partly.version_id(2)).status_code == 404
    assert cite(client, partly.version_id(1)).status_code == 200


# --------------------------------------------------------------------------- #
# Housekeeping
# --------------------------------------------------------------------------- #


def test_the_download_filename_names_the_version(client):
    paper = Paper()
    paper.add_version()
    stem = paper.version_id(1).replace(":", "-").replace("/", "-")

    bibtex = cite(client, paper.short_id, format="bibtex")
    ris = cite(client, paper.short_id, format="ris")

    assert bibtex.headers["content-disposition"] == f'inline; filename="{stem}.bib"'
    assert ris.headers["content-disposition"] == f'inline; filename="{stem}.ris"'


def test_the_catalog_routes_beside_cite_still_answer(client):
    paper = Paper()
    paper.add_version(title="First draft")
    paper.add_version(title="Second draft")

    assert client.get(f"/v1/papers/{paper.short_id}").json()["title"] == "Second draft"
    assert client.get(f"/v1/papers/{paper.version_id(1)}").json()["title"] == "First draft"
    assert client.get(f"/v1/papers/{paper.short_id}/versions").status_code == 200


def test_only_get_is_allowed(client):
    paper = Paper()
    paper.add_version()

    assert client.post(f"/v1/papers/{paper.short_id}/cite").status_code == 405
