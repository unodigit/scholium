"""Tests for ``GET /v1/oai`` (plugin: export, feature 94).

Papers are put in place through the submissions plugin's own ``save_paper`` /
``save_version`` -- the calls its record handlers make -- and listed with
``transition_version``, which is what a moderator's decision ends up calling.
Harvesting then goes through the public route with an anonymous client and the
answer is parsed as XML, so what is asserted is the OAI-PMH document a harvester
receives, not the code that built it.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Optional
from xml.etree import ElementTree as ET

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app.modules.export import oai as oai_module
from app.modules.submissions import (
    AWAITING_CONSENT,
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

URL = "/v1/oai"
OAI = "{http://www.openarchives.org/OAI/2.0/}"
OAI_DC = "{http://www.openarchives.org/OAI/2.0/oai_dc/}"
DC = "{http://purl.org/dc/elements/1.1/}"
DATESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

_TO_LISTED = ("scanning", "moderation", "listed")


class Paper:
    """One paper whose versions this test adds and lists."""

    def __init__(self, *, categories=("cs.CR",), licence="CC-BY-4.0") -> None:
        self.tag = uuid.uuid4().hex
        self.categories = list(categories)
        self.licence = licence
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": f"OAI paper {self.tag}",
                "abstract": "A paper a harvester may take.",
                "categories": self.categories,
                "licence": self.licence,
                "authors": [self.did],
            },
        )
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
            licence=self.licence,
        )
        self.short_id = derive_short_id(self.genesis["id"])
        self.versions: list[tuple[int, str, str, str]] = []

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
        self,
        *,
        title: Optional[str] = None,
        abstract: Optional[str] = None,
        state: str = AWAITING_CONSENT,
    ) -> tuple[int, str, str, str]:
        n = len(self.versions) + 1
        prev = self.versions[-1][1] if self.versions else self.genesis["id"]
        title = title or f"OAI paper {self.tag} -- version {n}"
        abstract = abstract or f"What version {n} says."
        record = self._sign(
            "paper.version",
            {"paper": self.genesis["id"], "n": n, "title": title, "abstract": abstract},
            prev=prev,
        )
        save_version(
            version_cid=record["id"],
            paper_cid=self.genesis["id"],
            n=n,
            title=title,
            abstract=abstract,
            manifest_cid="bafkreimanifest",
            licence=self.licence,
            prev_cid=prev,
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
        )
        version = (n, record["id"], title, abstract)
        self.versions.append(version)
        if state != AWAITING_CONSENT:
            transition_version(record["id"], state)
        return version

    def list_version(
        self, version: tuple[int, str, str, str], *, at: Optional[datetime] = None
    ) -> None:
        """Walk a version to ``listed``; ``at`` dates the listing."""
        for state in _TO_LISTED:
            transition_version(version[1], state, at=at if state == "listed" else None)

    @property
    def oai_identifier(self) -> str:
        return f"oai:scholium:{self.short_id}"


def harvest(client, **params) -> ET.Element:
    """GET ``/v1/oai`` with ``params`` and parse the answer."""
    response = client.get(URL, params=params)
    assert response.status_code == 200
    return ET.fromstring(response.content)


def records(root: ET.Element, verb: str = "ListRecords") -> list[ET.Element]:
    element = root.find(f"{OAI}{verb}")
    assert element is not None, ET.tostring(root)
    return element.findall(f"{OAI}record")


def matching(root: ET.Element, paper: Paper) -> list[ET.Element]:
    """The records whose header names ``paper`` (none when the answer is an error)."""
    element = root.find(f"{OAI}ListRecords")
    if element is None:  # e.g. noRecordsMatch for a filter that excludes everything
        return []
    return [
        record
        for record in element.findall(f"{OAI}record")
        if record.findtext(f"{OAI}header/{OAI}identifier") == paper.oai_identifier
    ]


def error_code(root: ET.Element) -> Optional[str]:
    error = root.find(f"{OAI}error")
    return None if error is None else error.get("code")


def dublin_core(record: ET.Element) -> ET.Element:
    metadata = record.find(f"{OAI}metadata")
    assert metadata is not None
    dc = metadata.find(f"{OAI_DC}dc")
    assert dc is not None
    return dc


def test_list_records_serves_dublin_core_for_a_listed_paper(client):
    paper = Paper()
    title = f"Harvested {paper.tag}"
    abstract = f"An abstract a harvester can index: {paper.tag}"
    version = paper.add_version(title=title, abstract=abstract)
    paper.list_version(version)

    root = harvest(client, verb="ListRecords")

    assert root.tag == f"{OAI}OAI-PMH"
    assert DATESTAMP.match(root.findtext(f"{OAI}responseDate"))
    request = root.find(f"{OAI}request")
    assert request is not None
    assert request.get("verb") == "ListRecords"
    assert request.text == "http://testserver/v1/oai"

    found = matching(root, paper)
    assert len(found) == 1
    record = found[0]
    assert DATESTAMP.match(record.findtext(f"{OAI}header/{OAI}datestamp"))

    dc = dublin_core(record)
    assert dc.findtext(f"{DC}title") == title
    assert [element.text for element in dc.findall(f"{DC}creator")] == [paper.did]
    assert [element.text for element in dc.findall(f"{DC}subject")] == ["cs.CR"]
    assert dc.findtext(f"{DC}description") == abstract
    identifiers = [element.text for element in dc.findall(f"{DC}identifier")]
    assert paper.short_id in identifiers
    assert f"{paper.short_id}/v1" in identifiers
    assert dc.findtext(f"{DC}rights") == "CC-BY-4.0"


def test_the_response_is_served_as_xml(client):
    paper = Paper()
    paper.list_version(paper.add_version())

    response = client.get(URL, params={"verb": "ListRecords"})

    assert response.status_code == 200
    assert "xml" in response.headers["content-type"]
    assert response.content.lstrip().startswith(b"<?xml")


def test_only_listed_papers_are_disseminated(client):
    listed = Paper()
    listed.list_version(listed.add_version())
    unlisted = Paper()
    unlisted.add_version()  # awaiting_consent: never in the public catalog

    root = harvest(client, verb="ListRecords")

    assert matching(root, listed)
    assert matching(root, unlisted) == []


def test_a_paper_is_described_by_its_latest_listed_version(client):
    paper = Paper()
    first = paper.add_version(title=f"First {paper.tag}")
    paper.list_version(first)
    second = paper.add_version(title=f"Second {paper.tag}")
    paper.list_version(second)

    root = harvest(client, verb="ListRecords")

    found = matching(root, paper)
    assert len(found) == 1
    dc = dublin_core(found[0])
    assert dc.findtext(f"{DC}title") == second[2]
    identifiers = [element.text for element in dc.findall(f"{DC}identifier")]
    assert f"{paper.short_id}/v2" in identifiers
    assert f"{paper.short_id}/v1" not in identifiers


def test_holding_a_version_withdraws_it_from_the_harvest(client):
    paper = Paper()
    version = paper.add_version()
    paper.list_version(version)
    assert matching(harvest(client, verb="ListRecords"), paper)

    transition_version(version[1], "held")

    assert matching(harvest(client, verb="ListRecords"), paper) == []


@pytest.mark.parametrize(
    "params",
    [{}, {"verb": ""}, {"verb": "Harvest"}, {"verb": "listrecords"}],
)
def test_a_missing_or_illegal_verb_is_bad_verb(client, params):
    response = client.get(URL, params=params)
    root = ET.fromstring(response.content)

    assert response.status_code == 200
    assert error_code(root) == "badVerb"
    # A badVerb request element carries no attributes at all.
    assert root.find(f"{OAI}request").attrib == {}


def test_an_unknown_argument_is_bad_argument(client):
    root = harvest(client, verb="ListRecords", colour="green")
    assert error_code(root) == "badArgument"


def test_a_metadata_prefix_other_than_dublin_core_is_refused(client):
    root = harvest(client, verb="ListRecords", metadataPrefix="marc21")

    assert error_code(root) == "cannotDisseminateFormat"
    request = root.find(f"{OAI}request")
    assert request.get("verb") == "ListRecords"
    assert request.get("metadataPrefix") == "marc21"


def test_metadata_prefix_oai_dc_is_accepted_explicitly(client):
    paper = Paper()
    paper.list_version(paper.add_version(title=f"Explicit prefix {paper.tag}"))

    root = harvest(client, verb="ListRecords", metadataPrefix="oai_dc")

    assert error_code(root) is None
    assert matching(root, paper)


def test_identify_describes_the_repository(client):
    root = harvest(client, verb="Identify")

    identity = root.find(f"{OAI}Identify")
    assert identity is not None
    assert identity.findtext(f"{OAI}repositoryName") == "Scholium"
    assert identity.findtext(f"{OAI}protocolVersion") == "2.0"
    assert identity.findtext(f"{OAI}baseURL") == "http://testserver/v1/oai"
    assert identity.findtext(f"{OAI}deletedRecord") == "no"
    assert identity.findtext(f"{OAI}granularity") == "YYYY-MM-DDThh:mm:ssZ"
    assert DATESTAMP.match(identity.findtext(f"{OAI}earliestDatestamp"))


def test_list_metadata_formats_offers_dublin_core(client):
    root = harvest(client, verb="ListMetadataFormats")

    format_element = root.find(f"{OAI}ListMetadataFormats/{OAI}metadataFormat")
    assert format_element is not None
    assert format_element.findtext(f"{OAI}metadataPrefix") == "oai_dc"
    assert format_element.findtext(f"{OAI}metadataNamespace") == (
        "http://purl.org/dc/elements/1.1/"
    )
    assert format_element.findtext(f"{OAI}schema").endswith("oai_dc.xsd")


def test_get_record_returns_one_listed_paper(client):
    paper = Paper()
    title = f"One record {paper.tag}"
    paper.list_version(paper.add_version(title=title))

    root = harvest(client, verb="GetRecord", identifier=paper.oai_identifier)

    element = root.find(f"{OAI}GetRecord")
    assert element is not None
    found = element.findall(f"{OAI}record")
    assert len(found) == 1
    assert dublin_core(found[0]).findtext(f"{DC}title") == title


def test_get_record_accepts_the_plain_short_id(client):
    paper = Paper()
    paper.list_version(paper.add_version())

    root = harvest(client, verb="GetRecord", identifier=paper.short_id)

    assert error_code(root) is None


def test_get_record_of_an_unlisted_or_unknown_paper_is_id_does_not_exist(client):
    unlisted = Paper()
    unlisted.add_version()

    assert error_code(
        harvest(client, verb="GetRecord", identifier=unlisted.oai_identifier)
    ) == "idDoesNotExist"
    assert error_code(
        harvest(client, verb="GetRecord", identifier="oai:scholium:sch:nowhere-nowhere-nowhere")
    ) == "idDoesNotExist"


def test_list_identifiers_returns_headers_without_metadata(client):
    paper = Paper()
    paper.list_version(paper.add_version())

    root = harvest(client, verb="ListIdentifiers")

    element = root.find(f"{OAI}ListIdentifiers")
    assert element is not None
    identifiers = [header.findtext(f"{OAI}identifier") for header in element.findall(f"{OAI}header")]
    assert paper.oai_identifier in identifiers
    assert element.find(f"{OAI}metadata") is None


def test_from_and_until_filter_the_harvest_by_datestamp(client):
    paper = Paper()
    listed_at = datetime(2019, 3, 1, 12, 0, 0)
    paper.list_version(paper.add_version(), at=listed_at)

    inside = harvest(
        client, verb="ListRecords", **{"from": "2019-03-01", "until": "2019-03-01"}
    )
    assert matching(inside, paper)

    after = harvest(client, verb="ListRecords", **{"from": "2019-03-02"})
    assert matching(after, paper) == []

    before = harvest(client, verb="ListRecords", **{"until": "2019-02-28"})
    assert matching(before, paper) == []


def test_an_invalid_datestamp_is_bad_argument(client):
    root = harvest(client, verb="ListRecords", **{"from": "yesterday"})
    assert error_code(root) == "badArgument"


def test_sets_are_not_supported(client):
    root = harvest(client, verb="ListSets")
    assert error_code(root) == "noSetHierarchy"

    root = harvest(client, verb="ListRecords", set="cs.CR")
    assert error_code(root) == "noSetHierarchy"


def test_a_long_harvest_continues_with_a_resumption_token(client, monkeypatch):
    monkeypatch.setattr(oai_module, "PAGE_SIZE", 1)
    first_paper = Paper()
    first_paper.list_version(
        first_paper.add_version(), at=datetime(2018, 7, 1, 9, 0, 0)
    )
    second_paper = Paper()
    second_paper.list_version(
        second_paper.add_version(), at=datetime(2018, 7, 1, 10, 0, 0)
    )

    window = {"from": "2018-07-01", "until": "2018-07-01"}
    root = harvest(client, verb="ListRecords", **window)
    page = records(root)
    assert len(page) == 1
    token_element = root.find(f"{OAI}ListRecords/{OAI}resumptionToken")
    assert token_element is not None
    assert token_element.get("completeListSize") == "2"
    assert token_element.get("cursor") == "0"
    token = token_element.text

    seen = [
        record.findtext(f"{OAI}header/{OAI}identifier") for record in page
    ]
    while token:
        root = harvest(client, verb="ListRecords", resumptionToken=token)
        page = records(root)
        seen.extend(
            record.findtext(f"{OAI}header/{OAI}identifier") for record in page
        )
        token_element = root.find(f"{OAI}ListRecords/{OAI}resumptionToken")
        token = token_element.text if token_element is not None else None

    # Newest listing first: the 10:00 paper before the 09:00 one.
    assert seen == [second_paper.oai_identifier, first_paper.oai_identifier]


def test_a_resumption_token_is_exclusive_and_must_be_valid(client):
    root = harvest(
        client, verb="ListRecords", resumptionToken="not-a-token", metadataPrefix="oai_dc"
    )
    assert error_code(root) == "badArgument"

    root = harvest(client, verb="ListRecords", resumptionToken="not-a-token")
    assert error_code(root) == "badResumptionToken"
