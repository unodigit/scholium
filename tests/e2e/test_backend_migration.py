"""Moving a live node to new backends with ``python -m app.migrate_backend``.

A node that has been running on SQLite and a content directory (the default,
no-container setup) is stopped and copied -- database and blobs -- to a new
database and an S3 bucket.  The copy must *be* the node: the node that starts
on it serves the same papers, the same bytes under the same CIDs, and exports
byte-for-byte the same archive.  The tool refuses what would make a bad copy: a
target that is not empty, a blob whose bytes do not hash to its CID, a source
whose hash chain is already broken.
"""

from __future__ import annotations

import shutil
import sqlite3
from contextlib import closing

import pytest

from e2e_harness import Node, assert_bytes_match_cid, json_of, poll, publish_listed_paper


@pytest.fixture(scope="module")
def source(nodes):
    """A stopped fs + SQLite node holding one listed paper (and its AI pre-review)."""
    node = nodes.make("source", storage="fs", jobs="thread")
    node.init_key()
    node.start_api()
    with node.client() as http:
        paper = publish_listed_paper(node, http, title="Migration paper")
        poll(
            lambda: http.get(f"/v1/papers/{paper.short_id}/ai-reviews").json().get("agents"),
            timeout=90, what="the AI pre-review (so the node is quiet before it is copied)",
        )
        evidence = {
            "paper": json_of(http.get(f"/v1/papers/{paper.short_id}")),
            "archive": http.get("/v1/export/archive.car").content,
            "head": json_of(http.get("/v1/sync/head")),
            "records": json_of(http.get("/v1/sync/range", params={"from": 1, "limit": 1000})),
        }
    node.stop()
    return node, paper, evidence


def migrate(source_node: Node, target_db: str, target_s3, *extra: str, **env):
    """``python -m app.migrate_backend`` from the source node's backends to ``target_db`` + ``target_s3``."""
    return source_node.python(
        "-m", "app.migrate_backend",
        "--from-db", f"sqlite:///{source_node.db_path}",
        "--to-db", target_db,
        "--from-storage", "fs",
        "--to-storage", "s3",
        *extra,
        **{**target_s3.settings(), **env},
    )


def test_a_dry_run_reports_and_writes_nothing(nodes, source, tmp_path):
    node, paper, _ = source
    target = nodes.s3("scholium-dry")
    destination = tmp_path / "dry.db"
    dry = migrate(node, f"sqlite:///{destination}", target, "--dry-run")
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "event_log" in dry.stdout, dry.stdout
    assert not destination.exists(), "a dry run created the target database"
    assert target.keys() == [], "a dry run wrote to the target bucket"


def test_the_copy_is_the_node(nodes, source, tmp_path):
    node, paper, evidence = source
    target_s3 = nodes.s3("scholium-copy")
    destination = tmp_path / "copy.db"

    done = migrate(node, f"sqlite:///{destination}", target_s3)
    assert done.returncode == 0, done.stdout + done.stderr

    # Every blob the node had is in the bucket under its CID, with the same bytes.
    blobs = sorted(p.name for p in node.content_dir.iterdir() if p.is_file())
    assert blobs and paper.file_cid in blobs
    assert target_s3.keys() == blobs
    for cid in blobs:
        assert_bytes_match_cid(target_s3.objects[cid], cid)
        assert target_s3.objects[cid] == (node.content_dir / cid).read_bytes()

    # A node started on the copy -- same signing key, new database, new store --
    # is the same node.
    copy = nodes.make("copy", storage="s3", jobs="thread", s3=target_s3, DATABASE_URL=f"sqlite:///{destination}")
    shutil.copy2(node.key_path, copy.key_path)
    copy.start_api()
    with copy.client() as http:
        assert json_of(http.get("/readyz"))["status"] == "ok"
        assert json_of(http.get(f"/v1/papers/{paper.short_id}")) == evidence["paper"]
        assert http.get(f"/v1/content/{paper.file_cid}").content == paper.pdf
        assert json_of(http.get("/v1/sync/head")) == evidence["head"]
        assert json_of(http.get("/v1/sync/range", params={"from": 1, "limit": 1000})) == evidence["records"]
        # The whole archive -- every record, every block -- is byte-identical.
        assert http.get("/v1/export/archive.car").content == evidence["archive"]
    copy.stop()

    # Doing it again into a target that already holds a node is refused, untouched.
    again = migrate(node, f"sqlite:///{destination}", target_s3)
    assert again.returncode == 1, again.stdout + again.stderr
    assert "not empty" in again.stderr, again.stderr


def test_a_blob_that_does_not_hash_to_its_cid_is_not_copied(nodes, source, tmp_path):
    node, paper, _ = source
    damaged = tmp_path / "damaged-content"
    shutil.copytree(node.content_dir, damaged)
    blob = damaged / paper.file_cid
    original = blob.read_bytes()
    blob.write_bytes(original[:-1] + bytes([original[-1] ^ 0xFF]))

    target_s3 = nodes.s3("scholium-damaged")
    refused = migrate(node, f"sqlite:///{tmp_path / 'damaged.db'}", target_s3, "--from-content-dir", str(damaged))
    assert refused.returncode == 1, refused.stdout + refused.stderr
    assert paper.file_cid in refused.stderr, refused.stderr
    assert paper.file_cid not in target_s3.keys(), "damaged bytes were stored under the CID"


def test_a_source_with_a_broken_hash_chain_is_not_copied(nodes, source, tmp_path):
    node, _, _ = source
    broken = tmp_path / "broken.db"
    shutil.copy2(node.db_path, broken)
    with closing(sqlite3.connect(broken)) as db:
        # What an attacker with the file would have to do: remove the guards, then edit.
        for (name,) in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'event_log'"
        ).fetchall():
            db.execute(f'DROP TRIGGER "{name}"')
        seq, raw = db.execute("SELECT seq, raw FROM event_log ORDER BY seq LIMIT 1 OFFSET 2").fetchone()
        db.execute("UPDATE event_log SET raw = ? WHERE seq = ?", (raw[:-1] + bytes([raw[-1] ^ 1]), seq))
        db.commit()

    refused = node.python(
        "-m", "app.migrate_backend",
        "--from-db", f"sqlite:///{broken}", "--to-db", f"sqlite:///{tmp_path / 'never.db'}",
        "--from-storage", "fs", "--to-storage", "fs", "--to-content-dir", str(tmp_path / "never-content"),
    )
    assert refused.returncode == 1, refused.stdout + refused.stderr
    assert f"seq {seq}" in refused.stderr, refused.stderr
    assert not (tmp_path / "never.db").exists()
