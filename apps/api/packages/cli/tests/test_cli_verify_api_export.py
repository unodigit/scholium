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
BUILD_LISTED_V1_WITH_QUEUED_V2 = """
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from app.main import create_app
from app.modules import ledger
from app.modules.export.tests.test_paper_car import build_paper
from app.modules.submissions import LISTED, MODERATION, VersionAuthor, save_version
from scholium_record_core import did_key_from_signing_key, sign_record

with TestClient(create_app()) as client:
    mixed = build_paper(state=LISTED)
    mixed.append(
        mixed.sign(
            "coauthor.consent",
            {"version": mixed.version["id"], "role": "author", "decision": "accept"},
        )
    )

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
                "manifest": mixed.manifest["id"],
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
        manifest_cid=mixed.manifest["id"],
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
                }
                for paper in (mixed, queued)
            ]
        )
    )
"""


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
