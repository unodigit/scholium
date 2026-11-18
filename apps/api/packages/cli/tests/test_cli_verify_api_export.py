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

#: What the child process runs: build two papers through the API, then export.
BUILD_AND_EXPORT = """
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.modules.export.tests.test_paper_car import build_paper

with TestClient(create_app()) as client:
    papers = [build_paper(), build_paper()]
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


def export_a_whole_node(tmp_path: Path) -> tuple[Path, list[dict[str, str]]]:
    """Run ``BUILD_AND_EXPORT`` in a fresh process; return its archive and ids."""
    key_path = tmp_path / "node.key"
    key_path.write_text(bytes(range(32)).hex())
    script = tmp_path / "build_and_export.py"
    script.write_text(BUILD_AND_EXPORT)
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
