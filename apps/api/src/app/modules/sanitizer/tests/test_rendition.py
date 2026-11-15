"""Tests for the node-signed ``rendition`` record (feature 64).

A version whose files all pass scanning gets one ``rendition`` record --
authored and signed by the node key -- listing its sanitized files and the
versions of the tools that cleared them.  A held version gets none.

The version helpers are shared with ``test_scan_job``.  Isolation is the same:
every test stores its own random bytes and creates its own version, because
xdist workers share a database and a content directory.
"""

from __future__ import annotations

import io
import logging
import socketserver
import struct
import threading
import uuid
import zipfile
from importlib import metadata

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_record_id,
    did_key_from_signing_key,
    sign_record,
    validate_body,
    verify_record,
)

from app.modules import content, ledger, sanitizer
from app.modules.ledger.records import stored_envelope
from app.modules.sanitizer import (
    CHECK_MANIFEST_UNREADABLE,
    RENDITION_TYPE,
    InvalidRendition,
    RenditionKeyUnavailable,
)
from app.modules.sanitizer.tools import _parse_clamd_version
from app.modules.submissions import (
    HELD,
    MODERATION,
    SCANNING,
    subscribe_version_state_changed,
    transition_version,
)
from app.settings import settings

from .test_scan_job import (  # noqa: F401  (the fixtures are used by name)
    BUNDLE,
    MANUSCRIPT,
    PLAIN,
    clean_pdf,
    entry,
    javascript_pdf,
    make_version,
    now,
    state_of,
    stored,
    subscribed,
    suspended,
)

# --------------------------------------------------------------------------- #
# Fixtures and helpers
# --------------------------------------------------------------------------- #


@pytest.fixture
def node_key(tmp_path, monkeypatch) -> SigningKey:
    """A node Ed25519 key at a temporary ``NODE_KEY_PATH``."""
    key = SigningKey.generate()
    path = tmp_path / "node.key"
    path.write_text(key.encode().hex())
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))
    return key


@pytest.fixture
def node_did(node_key) -> str:
    return did_key_from_signing_key(node_key)


@pytest.fixture(autouse=True)
def no_clamd(monkeypatch):
    """Archives only pass when a (fake) clamd answers; default to none."""
    monkeypatch.delenv("CLAMD_SOCKET", raising=False)


class _FakeClamd(socketserver.StreamRequestHandler):
    """Just enough of clamd's protocol: ``VERSION`` and ``INSTREAM``."""

    def handle(self) -> None:
        command = self.rfile.readline().strip()
        if command == b"VERSION":
            self.wfile.write(b"ClamAV 1.4.2/27500/Mon Nov 10 08:00:00 2026\n")
        elif command == b"INSTREAM":
            while True:
                (size,) = struct.unpack("!I", self.rfile.read(4))
                if size == 0:
                    break
                self.rfile.read(size)
            self.wfile.write(b"stream: OK\n")


@pytest.fixture
def clamd(monkeypatch):
    """A fake clamd on loopback, named by ``CLAMD_SOCKET``."""
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _FakeClamd)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("CLAMD_SOCKET", f"127.0.0.1:{server.server_address[1]}")
    yield server
    server.shutdown()
    server.server_close()


def clean_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("data/notes.txt", f"notes {uuid.uuid4().hex}")
    return buffer.getvalue()


def renditions_of(version_cid: str) -> list:
    """Every ``rendition`` entry in the log whose ``source`` is the version."""
    return [
        logged
        for logged in ledger.entries()
        if logged.record_type == RENDITION_TYPE and logged.body.get("source") == version_cid
    ]


def tool_names(body: dict) -> list[str]:
    return [tool["name"] for tool in body["tools"]]


# --------------------------------------------------------------------------- #
# A clean version gets a node-signed rendition
# --------------------------------------------------------------------------- #


def test_a_version_that_passes_scanning_gets_a_node_signed_rendition(node_did):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    notes = stored(b"supporting notes", PLAIN)
    version_cid = make_version(
        [entry(pdf, "paper.pdf", MANUSCRIPT), entry(notes, "notes.txt", PLAIN, "supplement")]
    )

    # The event path: entering ``scanning`` enqueues the scan, which signs.
    transition_version(version_cid, SCANNING, reason="all authors consented")

    assert state_of(version_cid) == MODERATION
    [logged] = renditions_of(version_cid)
    assert logged.record_type == "rendition"
    assert logged.author_did == node_did
    assert validate_body("rendition", logged.body) == []
    assert logged.body["source"] == version_cid
    assert logged.body["files"] == [
        {
            "path": "paper.pdf",
            "cid": pdf.cid,
            "size": pdf.size,
            "mediaType": MANUSCRIPT,
            "role": "manuscript",
            "scanStatus": "passed",
        },
        {
            "path": "notes.txt",
            "cid": notes.cid,
            "size": notes.size,
            "mediaType": PLAIN,
            "role": "supplement",
            "scanStatus": "passed",
        },
    ]


def test_the_rendition_names_the_paper_it_belongs_to(node_key, suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    sanitizer.scan_version(version_cid)

    from app.modules.submissions import get_version

    [logged] = renditions_of(version_cid)
    assert logged.body["paper"] == get_version(version_cid).paper_cid


def test_scan_version_reports_the_rendition_cid(node_key, suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    result = sanitizer.scan_version(version_cid)

    [logged] = renditions_of(version_cid)
    assert result.passed is True
    assert result.rendition_cid == logged.record_cid
    assert result.to_dict()["rendition_cid"] == logged.record_cid
    assert sanitizer.rendition_for(version_cid).record_cid == logged.record_cid


def test_the_job_path_signs_the_rendition_too(node_key, suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    sanitizer.enqueue_scan(version_cid)

    assert state_of(version_cid) == MODERATION
    assert len(renditions_of(version_cid)) == 1


def test_the_rendition_is_in_the_log_before_the_version_reaches_moderation(
    node_key, suspended
):
    """Anything reacting to ``moderation`` can already read the rendition."""
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)
    seen = []

    def on_state(event):
        if event.state == MODERATION and event.version_cid == version_cid:
            seen.append(sanitizer.rendition_for(version_cid))

    subscribe_version_state_changed(on_state)

    sanitizer.scan_version(version_cid)

    assert len(seen) == 1
    assert seen[0] is not None


# --------------------------------------------------------------------------- #
# The signature
# --------------------------------------------------------------------------- #


def test_create_rendition_signs_with_the_node_key_and_the_log_keeps_what_was_signed(
    node_key, node_did
):
    version_cid = f"bafyreiversion{uuid.uuid4().hex}"
    files = [{"path": "paper.pdf", "cid": "bafkreia", "scanStatus": "passed"}]
    tools = [{"name": "pypdf", "version": "1.0"}]

    result = sanitizer.create_rendition(version_cid, files, tools)

    assert result.created is True
    record = result.record
    assert record["type"] == "rendition"
    assert record["author"] == node_did
    assert record["id"] == result.record_cid
    assert verify_record(record) is True

    # Tampering with what was listed breaks the signature.
    forged = {**record, "body": {**record["body"], "files": []}}
    assert verify_record(forged) is False

    # The log holds exactly the signed content: the envelope served back for
    # the cid hashes to that cid.
    logged = ledger.entry_by_cid(result.record_cid)
    assert logged.author_did == node_did
    served = stored_envelope(logged).model_dump()
    assert compute_record_id(served) == result.record_cid


# --------------------------------------------------------------------------- #
# Tool versions
# --------------------------------------------------------------------------- #


def test_the_rendition_lists_the_tool_versions_that_scanned_a_pdf(node_key, suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    sanitizer.scan_version(version_cid)

    [logged] = renditions_of(version_cid)
    tools = {tool["name"]: tool for tool in logged.body["tools"]}
    assert tools["pypdf"]["version"] == metadata.version("pypdf")
    assert tools["scholium-sanitizer"]["version"] == metadata.version("scholium-api")
    assert "clamav" not in tools


def test_only_tools_that_ran_are_listed(node_key, suspended):
    notes = stored(b"just text, " + uuid.uuid4().bytes, PLAIN)
    version_cid = make_version([entry(notes, "notes.txt", PLAIN, "supplement")], state=SCANNING)

    sanitizer.scan_version(version_cid)

    [logged] = renditions_of(version_cid)
    assert tool_names(logged.body) == ["scholium-sanitizer"]


def test_an_archive_adds_the_clamav_version_asked_of_clamd(node_key, clamd, suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    bundle = stored(clean_zip(), BUNDLE)
    version_cid = make_version(
        [entry(pdf, "paper.pdf", MANUSCRIPT), entry(bundle, "source.zip", BUNDLE, "source")],
        state=SCANNING,
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == MODERATION
    [logged] = renditions_of(version_cid)
    tools = {tool["name"]: tool for tool in logged.body["tools"]}
    assert tools["clamav"] == {"name": "clamav", "version": "1.4.2", "database": "27500"}
    assert tools["pypdf"]["version"] == metadata.version("pypdf")


def test_an_unreachable_clamd_leaves_the_version_out_rather_than_guessing():
    assert sanitizer.tools._clamd_version("127.0.0.1:1") == (None, None)


@pytest.mark.parametrize(
    "reply, expected",
    [
        ("ClamAV 1.4.2/27500/Mon Nov 10 08:00:00 2026", ("1.4.2", "27500")),
        ("ClamAV 0.103.8", ("0.103.8", None)),
        ("something else entirely", (None, None)),
        ("ClamAV ", (None, None)),
        ("", (None, None)),
    ],
)
def test_clamd_version_replies_are_parsed(reply, expected):
    assert _parse_clamd_version(reply) == expected


# --------------------------------------------------------------------------- #
# Held versions get no rendition
# --------------------------------------------------------------------------- #


def test_a_held_version_gets_no_rendition(node_key, suspended):
    clean = stored(clean_pdf(), MANUSCRIPT)
    evil = stored(javascript_pdf(), MANUSCRIPT)
    version_cid = make_version(
        [entry(clean, "paper.pdf", MANUSCRIPT), entry(evil, "appendix.pdf", MANUSCRIPT)],
        state=SCANNING,
    )

    result = sanitizer.scan_version(version_cid)

    assert result.state == HELD
    assert result.rendition_cid is None
    assert renditions_of(version_cid) == []
    assert sanitizer.rendition_for(version_cid) is None


def test_a_version_held_for_an_unreadable_manifest_gets_no_rendition(node_key, suspended):
    version_cid = make_version(
        [], manifest_cid=f"bafyreimissing{uuid.uuid4().hex}", state=SCANNING
    )

    result = sanitizer.scan_version(version_cid)

    assert result.failing_check == CHECK_MANIFEST_UNREADABLE
    assert result.rendition_cid is None
    assert renditions_of(version_cid) == []


def test_a_version_that_is_not_scanning_gets_no_rendition(node_key):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)])

    result = sanitizer.scan_version(version_cid)

    assert result.skipped is True
    assert result.rendition_cid is None
    assert renditions_of(version_cid) == []


# --------------------------------------------------------------------------- #
# One rendition per node and version
# --------------------------------------------------------------------------- #


def test_creating_a_rendition_twice_appends_it_once(node_key):
    version_cid = f"bafyreiversion{uuid.uuid4().hex}"
    files = [{"path": "paper.pdf", "cid": "bafkreia"}]
    tools = [{"name": "pypdf", "version": "1.0"}]

    first = sanitizer.create_rendition(version_cid, files, tools)
    second = sanitizer.create_rendition(version_cid, files, tools)

    assert first.created is True
    assert second.created is False
    assert second.record is None
    assert second.record_cid == first.record_cid
    assert second.body == first.body
    assert len(renditions_of(version_cid)) == 1


def test_a_rescan_after_the_record_was_written_reuses_it(node_key, suspended):
    """A retried job -- the move failed after the signing -- appends nothing."""
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)
    first = sanitizer.scan_version(version_cid)
    assert state_of(version_cid) == MODERATION

    transition_version(version_cid, SCANNING)  # as if the move had never happened
    again = sanitizer.scan_version(version_cid)

    assert again.state == MODERATION
    assert again.rendition_cid == first.rendition_cid
    assert len(renditions_of(version_cid)) == 1


# --------------------------------------------------------------------------- #
# A node that cannot sign
# --------------------------------------------------------------------------- #


def test_a_node_without_a_key_still_moves_the_version_on(
    tmp_path, monkeypatch, caplog, suspended
):
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(tmp_path / "missing.key"))
    pdf = stored(clean_pdf(), MANUSCRIPT)
    version_cid = make_version([entry(pdf, "paper.pdf", MANUSCRIPT)], state=SCANNING)

    with caplog.at_level(logging.ERROR, logger=sanitizer.scan_job.__name__):
        result = sanitizer.scan_version(version_cid)

    # The files did pass; a missing provenance record must not strand them.
    assert result.state == MODERATION
    assert state_of(version_cid) == MODERATION
    assert result.rendition_cid is None
    assert renditions_of(version_cid) == []
    assert "could not create a rendition" in caplog.text


def test_create_rendition_without_a_key_raises_and_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(tmp_path / "missing.key"))
    version_cid = f"bafyreiversion{uuid.uuid4().hex}"

    with pytest.raises(RenditionKeyUnavailable):
        sanitizer.create_rendition(
            version_cid,
            [{"path": "paper.pdf", "cid": "bafkreia"}],
            [{"name": "pypdf", "version": "1.0"}],
        )

    assert renditions_of(version_cid) == []
    assert not (tmp_path / "missing.key").exists()  # the key is never created


# --------------------------------------------------------------------------- #
# The body is checked against the rendition schema
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "version_cid, files, tools",
    [
        ("", [{"path": "a", "cid": "c"}], [{"name": "t"}]),
        ("v", [], [{"name": "t"}]),
        ("v", [{"path": "a"}], [{"name": "t"}]),
        ("v", [{"path": "", "cid": "c"}], [{"name": "t"}]),
        ("v", [{"path": "a", "cid": "c"}], []),
    ],
)
def test_an_invalid_body_is_refused_before_anything_is_signed(
    node_key, version_cid, files, tools
):
    with pytest.raises(InvalidRendition):
        sanitizer.build_rendition_body(version_cid, files, tools)
    with pytest.raises(InvalidRendition):
        sanitizer.create_rendition(version_cid, files, tools)


def test_build_rendition_body_has_the_documented_shape():
    body = sanitizer.build_rendition_body(
        "bafyreiv",
        [{"path": "paper.pdf", "cid": "bafkreia", "size": 3}],
        [{"name": "pypdf", "version": "1.0"}],
        paper_cid="bafyreip",
    )

    assert body == {
        "source": "bafyreiv",
        "paper": "bafyreip",
        "files": [{"path": "paper.pdf", "cid": "bafkreia", "size": 3}],
        "tools": [{"name": "pypdf", "version": "1.0"}],
    }


# --------------------------------------------------------------------------- #
# Finding a version's rendition
# --------------------------------------------------------------------------- #


def test_rendition_for_finds_other_nodes_records_and_filters_by_author(node_key, node_did):
    version_cid = f"bafyreiversion{uuid.uuid4().hex}"
    other = SigningKey.generate()
    record = sign_record(
        {
            "v": 1,
            "type": "rendition",
            "author": did_key_from_signing_key(other),
            "created": now(),
            "prev": None,
            # The schema also accepts ``sourceVersion`` and ``toolVersions``.
            "body": {
                "sourceVersion": version_cid,
                "files": [{"path": "paper.pdf", "cid": "bafkreia"}],
                "toolVersions": ["pypdf 1.0"],
            },
            "proofs": [],
        },
        other,
    )
    ledger.append(record)

    assert sanitizer.rendition_for(version_cid).record_cid == record["id"]
    assert sanitizer.rendition_for(version_cid, author=did_key_from_signing_key(other)) is not None
    assert sanitizer.rendition_for(version_cid, author=node_did) is None
    assert sanitizer.rendition_for("bafyreiunknown") is None
    assert sanitizer.rendition_for("") is None

    # Another node's rendition does not stand in for this node's own.
    mine = sanitizer.create_rendition(
        version_cid,
        [{"path": "paper.pdf", "cid": "bafkreia"}],
        [{"name": "pypdf", "version": "1.0"}],
    )
    assert mine.created is True
    assert sanitizer.rendition_for(version_cid, author=node_did).record_cid == mine.record_cid


def test_a_files_kind_is_part_of_its_scan_result(node_key, clamd, suspended):
    pdf = stored(clean_pdf(), MANUSCRIPT)
    bundle = stored(clean_zip(), BUNDLE)
    notes = stored(b"notes " + uuid.uuid4().bytes, PLAIN)
    version_cid = make_version(
        [
            entry(pdf, "paper.pdf", MANUSCRIPT),
            entry(bundle, "source.zip", BUNDLE, "source"),
            entry(notes, "notes.txt", PLAIN, "supplement"),
        ],
        state=SCANNING,
    )

    result = sanitizer.scan_version(version_cid)

    assert [file.kind for file in result.files] == ["pdf", "bundle", "other"]
    assert [file["kind"] for file in result.to_dict()["files"]] == ["pdf", "bundle", "other"]
    assert content.get_blob(bundle.cid).scan_status == "passed"
