"""``scholium verify archive.car`` on the file ``POST /network`` links to.

The network page tells a reader to download ``/v1/export/archive.car`` and
check it with ``scholium verify archive.car``.  This test builds several papers
through the real API, downloads the whole-node archive from the real route and
runs that documented command over the bytes the API served.  It is the
regression test for the export failing the check the page recommends.

The API runs in a child process with its own database, content directory and
node key.  The event log is append-only and shared by every test in an xdist
worker, so an in-process run would export records other tests appended and
would not describe a single honest node.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from car_helpers import flip, write_car
from scholium_cli.car import read_car
from scholium_cli.main import main

#: The API's workspace root (``apps/api``), the directory ``uv run`` uses.
API_ROOT = Path(__file__).resolve().parents[3]

#: What the child process runs: build a listed and a queued paper through the
#: API, then export.  The first is put in the catalog by the ``list`` decision
#: the node records; the second is left in the moderation queue, which is what
#: a paper with no decision yet is.
BUILD_AND_EXPORT = """
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from app.main import create_app
from app.modules import ledger
from app.modules.export.tests.test_paper_car import build_paper
from app.modules.submissions import LISTED, MODERATION
from scholium_record_core import did_key_from_signing_key, sign_record

with TestClient(create_app()) as client:
    listed = build_paper(state=LISTED)
    queued = build_paper(state=MODERATION)
    papers = [listed, queued]
    for paper in papers:
        paper.append(
            paper.sign(
                "coauthor.consent",
                {
                    "version": paper.version["id"],
                    "role": "author",
                    "decision": "accept",
                },
            )
        )
    moderator_key = SigningKey.generate()
    ledger.append(
        sign_record(
            {
                "v": 1,
                "type": "moderation.decision",
                "author": did_key_from_signing_key(moderator_key),
                "created": "2026-11-15T09:00:03Z",
                "prev": None,
                "body": {
                    "target": listed.version["id"],
                    "action": "list",
                    "clause": "MOD-01",
                    "reason": "In scope and scholarly form.",
                },
                "proofs": [],
            },
            moderator_key,
        )
    )
    response = client.get("/v1/export/archive.car")
    if response.status_code != 200:
        print(
            f"archive export failed: {response.status_code} {response.text}",
            file=sys.stderr,
        )
        raise SystemExit(1)
    Path(sys.argv[1]).write_bytes(response.content)
    print(
        json.dumps(
            [
                {
                    "short_id": paper.short_id,
                    "genesis": paper.genesis["id"],
                    "version": paper.version["id"],
                }
                for paper in papers
            ]
        )
    )
"""


#: Build a paper whose v1 is listed and whose v2 is still in the queue, beside
#: a paper with no listed version at all, then export.  The node keeps serving
#: the listed v1 (``GET /v1/papers/{id}`` resolves to it), so the summary must
#: count the first paper as listed and only the second as awaiting moderation.
#:
#: v2 names a manuscript of its own.  No listed version names those bytes, so
#: an anonymous export leaves v2's file out while v1's stays in: the archive
#: holds exactly what a reader of the listed v1 may read, and ``scholium
#: verify`` must check v1's file -- not report the queued v2's as missing.
BUILD_LISTED_V1_WITH_QUEUED_V2 = """
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from app.main import create_app
from app.modules import content, ledger
from app.modules.export.tests.test_paper_car import build_paper
from app.modules.submissions import LISTED, MODERATION, VersionAuthor, save_version
from scholium_record_core import (
    compute_file_id,
    did_key_from_signing_key,
    sign_record,
)

with TestClient(create_app()) as client:
    mixed = build_paper(state=LISTED)
    mixed.append(
        mixed.sign(
            "coauthor.consent",
            {"version": mixed.version["id"], "role": "author", "decision": "accept"},
        )
    )

    v2_data = b"second manuscript, still in moderation"
    v2_file = compute_file_id(v2_data)
    content.store_bytes(v2_data, media_type="application/pdf")
    content.set_scan_status(v2_file, content.SCAN_PASSED)
    v2_manifest = mixed.sign(
        "manifest",
        {
            "files": [
                {
                    "path": "paper.pdf",
                    "cid": v2_file,
                    "size": len(v2_data),
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ]
        },
    )
    ledger.append(v2_manifest)

    # v2 is posted after v1 is listed; no moderator has decided on it, so the
    # node keeps serving v1 and the paper does not leave the catalog.
    v2 = sign_record(
        {
            "v": 1,
            "type": "paper.version",
            "author": mixed.did,
            "created": "2026-11-15T09:00:04Z",
            "prev": mixed.version["id"],
            "body": {
                "paper": mixed.genesis["id"],
                "n": 2,
                "title": mixed.version["body"]["title"],
                "abstract": mixed.version["body"]["abstract"],
                "authors": [
                    {
                        "did": mixed.did,
                        "position": 1,
                        "creditRoles": ["Conceptualization"],
                    }
                ],
                "manifest": v2_manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "second version",
            },
            "proofs": [],
        },
        mixed.key,
    )
    ledger.append(v2)
    ledger.append(
        mixed.sign(
            "coauthor.consent",
            {"version": v2["id"], "role": "author", "decision": "accept"},
        )
    )
    save_version(
        version_cid=v2["id"],
        paper_cid=mixed.genesis["id"],
        n=2,
        title=v2["body"]["title"],
        abstract=v2["body"]["abstract"],
        manifest_cid=v2_manifest["id"],
        licence="CC-BY-4.0",
        prev_cid=mixed.version["id"],
        authors=(VersionAuthor(mixed.did, 1, ("Conceptualization",)),),
        state=MODERATION,
    )

    moderator_key = SigningKey.generate()
    ledger.append(
        sign_record(
            {
                "v": 1,
                "type": "moderation.decision",
                "author": did_key_from_signing_key(moderator_key),
                "created": "2026-11-15T09:00:05Z",
                "prev": None,
                "body": {
                    "target": mixed.version["id"],
                    "action": "list",
                    "clause": "MOD-01",
                    "reason": "In scope and scholarly form.",
                },
                "proofs": [],
            },
            moderator_key,
        )
    )

    # A paper with no listed version: nothing to serve, so it stays queued.
    queued = build_paper(state=MODERATION)
    queued.append(
        queued.sign(
            "coauthor.consent",
            {"version": queued.version["id"], "role": "author", "decision": "accept"},
        )
    )

    response = client.get("/v1/export/archive.car")
    if response.status_code != 200:
        print(
            f"archive export failed: {response.status_code} {response.text}",
            file=sys.stderr,
        )
        raise SystemExit(1)
    Path(sys.argv[1]).write_bytes(response.content)
    print(
        json.dumps(
            [
                {
                    "short_id": paper.short_id,
                    "genesis": paper.genesis["id"],
                    "version": paper.version["id"],
                    "file_cid": paper.file_cid,
                }
                for paper in (mixed, queued)
            ]
        )
    )
"""


def paper_block(out: str, short_id: str) -> str:
    """The lines of one paper's block in a whole-node checklist."""
    start = out.index(f"Paper {short_id}")
    rest = out[start:]
    end = rest.find("\n\nPaper ", 1)
    if end == -1:
        end = rest.find("\n\nResult:", 1)
    return rest[: end if end != -1 else len(rest)]


def export_a_whole_node(
    tmp_path: Path, script_text: str = BUILD_AND_EXPORT
) -> tuple[Path, list[dict[str, str]]]:
    """Run a build-and-export script in a fresh process; return archive and ids."""
    key_path = tmp_path / "node.key"
    key_path.write_text(bytes(range(32)).hex())
    script = tmp_path / "build_and_export.py"
    script.write_text(script_text)
    archive = tmp_path / "archive.car"

    env = dict(os.environ)
    env.pop("TEST_DATABASE_URL", None)
    env.pop("SCHOLIUM_ENV", None)
    env.update(
        {
            "DATABASE_URL": f"sqlite:///{tmp_path / 'node.db'}",
            "CONTENT_DIR": str(tmp_path / "content"),
            "NODE_KEY_PATH": str(key_path),
            "STORAGE_BACKEND": "fs",
            "JOBS_EAGER": "1",
            "RATE_LIMIT_ENABLED": "0",
            "AI_PROVIDER": "fake",
            "ORCID_MOCK": "1",
            "ARXIV_MOCK": "1",
            "PYTHONPATH": os.pathsep.join(
                [
                    str(API_ROOT / "src"),
                    str(API_ROOT / "packages" / "record-core" / "src"),
                    str(API_ROOT / "packages" / "cli" / "src"),
                ]
            ),
        }
    )

    completed = subprocess.run(
        [sys.executable, str(script), str(archive)],
        cwd=API_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return archive, json.loads(completed.stdout.strip().splitlines()[-1])


def test_the_documented_command_verifies_the_api_export(tmp_path, capsys):
    archive, papers = export_a_whole_node(tmp_path)
    assert len(papers) == 2

    code = main(["verify", str(archive)])
    out = capsys.readouterr().out

    assert code == 0, out
    assert "Result: VERIFIED" in out
    assert "Result: VERIFIED — 2 papers (1 listed, 1 awaiting moderation)" in out
    for paper in papers:
        assert paper["short_id"] in out


def test_a_listed_earlier_version_keeps_the_paper_listed(tmp_path, capsys):
    """A queued newer version must not move a listed paper into the queue.

    The node serves a paper while any of its versions is listed (its catalog
    resolves ``GET /v1/papers/{id}`` to the newest *listed* version and counts
    a paper with at least one listed version on ``/network``).  So a paper
    whose v1 is listed and whose v2 is still in the queue stays "listed" in
    the summary, and only a paper with no listed version is "awaiting
    moderation".
    """
    archive, papers = export_a_whole_node(tmp_path, BUILD_LISTED_V1_WITH_QUEUED_V2)
    assert len(papers) == 2

    code = main(["verify", str(archive)])
    out = capsys.readouterr().out

    assert code == 0, out
    assert "Result: VERIFIED — 2 papers (1 listed, 1 awaiting moderation)" in out
    assert "2 awaiting moderation" not in out
    for paper in papers:
        assert paper["short_id"] in out


def test_a_listed_version_is_verified_when_a_newer_one_is_queued(tmp_path, capsys):
    """The archive holds the listed version's file: compare it, not v2's.

    A paper whose v1 is listed and whose v2 is queued is served as v1 (the
    catalog resolves its ``sch:`` id to the newest *listed* version), and the
    export carries v1's file -- not v2's, which no listed version names.  So
    the per-paper block must verify v1 and compare its file with v1's signed
    manifest, and note on one line that the newer version is not in the
    archive.
    """
    archive, papers = export_a_whole_node(tmp_path, BUILD_LISTED_V1_WITH_QUEUED_V2)
    listed, queued = papers

    code = main(["verify", str(archive)])
    out = capsys.readouterr().out

    assert code == 0, out
    block = paper_block(out, listed["short_id"])
    assert "The file matches the signed manifest" in block
    assert "The file contents are not in this archive" not in block
    assert (
        "1 newer version awaiting moderation (its file is not in this archive)"
        in block
    )

    # A paper with no listed version is unchanged: its only file is not in the
    # archive, and there is no newer version to note.
    queued_block = paper_block(out, queued["short_id"])
    assert "The file contents are not in this archive" in queued_block
    assert "newer version awaiting moderation" not in queued_block

    assert "Result: VERIFIED — 2 papers (1 listed, 1 awaiting moderation)" in out


def test_a_corrupt_listed_version_file_in_the_export_fails(tmp_path, capsys):
    """The listed version's file is checked, so corrupt bytes fail the check.

    Flipping a byte of v1's file block leaves the block not matching its file
    id; the listed v1's file check must report that the bytes are not the
    manifest's.  (The archive-wide block check fails too; the per-paper line
    is what proves v1 was verified rather than the queued v2.)
    """
    archive, papers = export_a_whole_node(tmp_path, BUILD_LISTED_V1_WITH_QUEUED_V2)
    listed = papers[0]

    carried = read_car(archive.read_bytes())
    blocks = [
        (
            block.cid,
            flip(block.data, 0)
            if str(block.cid.set(base="base32")) == listed["file_cid"]
            else block.data,
        )
        for block in carried.blocks
    ]
    broken = tmp_path / "broken-file.car"
    broken.write_bytes(write_car(blocks, roots=carried.roots))

    code = main(["verify", str(broken)])
    out = capsys.readouterr().out

    assert code == 1, out
    block = paper_block(out, listed["short_id"])
    assert "1 of 1 files failed the check against the signed manifest" in block
    assert "the bytes in the archive do not hash to the signed file id" in block


def test_the_documented_command_names_a_paper_that_does_not_verify(tmp_path, capsys):
    archive, papers = export_a_whole_node(tmp_path)
    broken_paper = papers[1]

    # Rewrite one paper's version record so its bytes no longer hash to the
    # record id it is filed under.  The block is corrupt, so that paper's
    # history cannot be verified while the other paper still can.
    carried = read_car(archive.read_bytes())
    blocks = [
        (
            block.cid,
            flip(block.data, 0)
            if str(block.cid.set(base="base32")) == broken_paper["version"]
            else block.data,
        )
        for block in carried.blocks
    ]
    broken = tmp_path / "broken.car"
    broken.write_bytes(write_car(blocks, roots=carried.roots))

    code = main(["verify", str(broken)])
    out = capsys.readouterr().out

    assert code == 1, out
    assert "Result: NOT VERIFIED" in out
    assert broken_paper["short_id"] in out
