"""Journey: a third party keeps a node's whole archive, checks it offline and rebuilds from it.

A paper is published through ``/v1`` (manifest, genesis, version, three
consents, a moderator's ``list`` decision).  Then someone who trusts nothing
the node says downloads ``GET /v1/export/archive.car`` and works only from that
file with the ``scholium`` command-line tool, run as a real process:

* ``scholium verify archive.car`` re-hashes every block and re-verifies the
  paper, and exits 0;
* ``scholium rebuild archive.car --db rebuilt.db`` replays the log's hash chain,
  re-authenticates every record and writes the paper, version and status views
  into a fresh database, and exits 0;
* after exactly one byte of a record inside the archive is altered -- in the
  middle of a title, so the file is still a well-formed archive and the record
  still decodes -- both commands exit 1, and the failed rebuild leaves no
  database behind.
"""

from __future__ import annotations

import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

from multiformats import CID
from scholium_record_core import derive_short_id, record_bytes

from .helpers import Actor
from .test_publish_journey import blank_pdf, make_author, upload_pdf

#: The media type the archive is served under (a CARv1 archive).
CAR_MEDIA_TYPE = "application/vnd.ipld.car"

#: The title of the published version; one letter of it is altered below (``v1`` -> ``w1``).
VERSION_TITLE = "Archive Journey v1"

EXIT_OK = 0
EXIT_NOT_VERIFIED = 1


def scholium(*args: str | Path, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run the ``scholium`` command line as a real process and return what it did.

    ``python -m scholium_cli.main`` is the console script's entry point, so this
    is exactly the program a third party runs -- exit code included -- without
    depending on where the virtual environment put the ``scholium`` shim.
    """
    return subprocess.run(
        [sys.executable, "-I", "-m", "scholium_cli.main", *map(str, args)],
        capture_output=True,
        check=False,
        text=True,
        encoding="utf-8",
        cwd=cwd,
    )


def publish_listed_paper(client, reviewer) -> dict:
    """Publish a paper by an author and two co-authors and have a moderator list it.

    Returns what a reader of the archive can look for: the paper's ``sch:`` id,
    the record ids of its genesis, version and manifest, and the signed version
    envelope itself (whose canonical bytes are what its block holds).
    """
    from app import jobs
    from app.modules.admin.cli import main as admin_cli

    moderator = Actor(client)
    moderator.sign_in()
    assert admin_cli(["set-tier", moderator.did, "moderator"]) == 0
    moderator.refresh()
    assert moderator.tier == 4

    author = make_author(client, reviewer)
    co1, co2 = Actor(client), Actor(client)
    co1.sign_in()
    co2.sign_in()

    pdf = blank_pdf()
    file_cid = upload_pdf(client, pdf)

    manifest = author.record(
        "manifest",
        {
            "files": [
                {
                    "path": "main.pdf",
                    "cid": file_cid,
                    "size": len(pdf),
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ]
        },
    )
    assert author.submit(manifest).status_code == 201

    genesis = author.record(
        "paper.genesis",
        {
            "title": "Archive Journey",
            "abstract": "A paper that ends up in the node's archive.",
            "categories": ["cs.AI"],
            "licence": "CC-BY-4.0",
            "authors": [author.did, co1.did, co2.did],
        },
    )
    assert author.submit(genesis).status_code == 201

    version = author.record(
        "paper.version",
        {
            "paper": genesis["id"],
            "n": 1,
            "title": VERSION_TITLE,
            "abstract": "The first version.",
            "authors": [
                {"did": who.did, "position": position, "creditRoles": ["Conceptualization"]}
                for position, who in enumerate((author, co1, co2), start=1)
            ],
            "manifest": manifest["id"],
            "licence": "CC-BY-4.0",
            "changeNote": "v1",
        },
        prev=genesis["id"],
    )
    assert author.submit(version).status_code == 201

    for who in (author, co1, co2):
        consent = who.record(
            "coauthor.consent",
            {"version": version["id"], "role": "Conceptualization", "decision": "accept"},
        )
        assert who.submit(consent).status_code == 201

    # Consent completing moves the version to scanning; the scan job passes it on.
    jobs.run_pending()
    clause = client.get("/v1/moderation/policies").json()[0]["id"]
    decision = moderator.record(
        "moderation.decision",
        {"target": version["id"], "action": "list", "clause": clause, "reason": "ok"},
    )
    listed = moderator.submit(decision)
    assert listed.status_code == 201, listed.text
    assert listed.json()["state"] == "listed", listed.text

    return {
        "short_id": derive_short_id(genesis["id"]),
        "genesis": genesis["id"],
        "version": version["id"],
        "manifest": manifest["id"],
        "version_envelope": version,
    }


def export_archive(client, into: Path) -> bytes:
    """Download ``GET /v1/export/archive.car``, save it as ``archive.car`` in ``into``."""
    response = client.get("/v1/export/archive.car")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(CAR_MEDIA_TYPE), response.headers
    assert 'filename="archive.car"' in response.headers["content-disposition"], response.headers
    assert response.content, "the archive is empty"
    (into / "archive.car").write_bytes(response.content)
    return response.content


def alter_one_byte(archive: bytes, record: dict) -> bytes:
    """``archive`` with a single byte of the record ``record`` changed.

    A CAR section is ``varint(length) cid data``, and a record's data is its
    canonical bytes, so the record's own section is the one place its binary CID
    is followed directly by those bytes.  (The same bytes also appear inside the
    record's log entry, as ``raw``; going through the CID leaves that copy alone.)

    The byte altered is a letter inside the version's title (``v1`` becomes
    ``w1``), so the archive stays well formed and the record still decodes: only
    the hash the record id commits to no longer matches.
    """
    section = bytes(CID.decode(record["id"])) + record_bytes(record)
    at = archive.find(section)
    assert at != -1, f"{record['id']} is not in the archive"
    assert archive.find(section, at + 1) == -1, f"{record['id']} is filed twice"

    title = VERSION_TITLE.encode()
    letter = at + len(bytes(CID.decode(record["id"]))) + record_bytes(record).index(title)
    letter += VERSION_TITLE.index("v1")
    altered = bytearray(archive)
    assert altered[letter : letter + 2] == b"v1"
    altered[letter] = ord("w")
    return bytes(altered)


def test_archive_car_journey(client, reviewer, tmp_path):
    ids = publish_listed_paper(client, reviewer)
    archive = export_archive(client, tmp_path)
    short_id = ids["short_id"]

    # --- scholium verify: offline, from the file alone -----------------------
    verified = scholium("verify", "archive.car", cwd=tmp_path)
    assert verified.returncode == EXIT_OK, verified.stdout + verified.stderr
    assert "Result: VERIFIED" in verified.stdout, verified.stdout
    assert short_id in verified.stdout, verified.stdout

    # --- scholium rebuild: the views come back from the archive alone --------
    rebuilt_db = tmp_path / "rebuilt.db"
    rebuilt = scholium("rebuild", "archive.car", "--db", rebuilt_db, cwd=tmp_path)
    assert rebuilt.returncode == EXIT_OK, rebuilt.stdout + rebuilt.stderr
    assert "Rebuilt 1 paper (1 version)" in rebuilt.stdout, rebuilt.stdout
    assert "Result: REBUILT (1 paper)" in rebuilt.stdout, rebuilt.stdout

    # A paper row is titled after its newest version, which here is v1.
    with closing(sqlite3.connect(f"file:{rebuilt_db}?mode=ro", uri=True)) as db:
        papers = db.execute("SELECT paper_cid, short_id, title FROM paper").fetchall()
        versions = db.execute("SELECT version_cid, n, title FROM paper_version").fetchall()
    assert papers == [(ids["genesis"], short_id, VERSION_TITLE)], papers
    assert versions == [(ids["version"], 1, VERSION_TITLE)], versions

    # --- one byte of a record altered ---------------------------------------
    altered = alter_one_byte(archive, ids["version_envelope"])
    assert len(altered) == len(archive)
    assert sum(a != b for a, b in zip(archive, altered)) == 1
    (tmp_path / "altered.car").write_bytes(altered)

    # Exit 1 alone would also be the answer to any other defect, so each command
    # must also say why: the altered record's block no longer matches its id.
    altered_id = ids["version"]

    refused = scholium("verify", "--verbose", "altered.car", cwd=tmp_path)
    assert refused.returncode == EXIT_NOT_VERIFIED, refused.stdout + refused.stderr
    assert "NOT VERIFIED" in refused.stdout, refused.stdout
    assert altered_id in refused.stdout and "do not match" in refused.stdout, refused.stdout

    broken_db = tmp_path / "broken.db"
    not_rebuilt = scholium("rebuild", "altered.car", "--db", broken_db, cwd=tmp_path)
    assert not_rebuilt.returncode == EXIT_NOT_VERIFIED, not_rebuilt.stdout + not_rebuilt.stderr
    assert "NOT REBUILT" in not_rebuilt.stdout, not_rebuilt.stdout
    assert altered_id in not_rebuilt.stdout and "do not match" in not_rebuilt.stdout, not_rebuilt.stdout
    assert not broken_db.exists(), "a failed rebuild must leave no database behind"

    # The pristine archive is still good: it was the copy that was altered.
    assert scholium("verify", "archive.car", cwd=tmp_path).returncode == EXIT_OK
