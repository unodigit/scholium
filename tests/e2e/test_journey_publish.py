"""Journey: a paper is published and read, on two different deployments of the same code.

The node is started the way an operator starts it (``init-node``, then
``python -m app``, plus ``python -m app.worker`` where jobs run externally) and
everything after that goes over HTTP:

``fs+worker``
    the no-container layout: SQLite, blobs under ``CONTENT_DIR``, and a *separate*
    worker process that claims the jobs the API queues (``JOBS_MODE=external``);
``s3+thread``
    blobs in an S3-compatible bucket, jobs run by the API's own worker thread
    (``JOBS_MODE=thread``).

Same assertions on both: what the ledger records, what is served for a CID and
how, what the public catalog shows, and what a third party can verify offline.
"""

from __future__ import annotations

import sys

import pytest

from e2e_harness import assert_bytes_match_cid, clean_env, json_of, poll, run_command


def test_node_is_ready_on_its_backends(node, http):
    ready = json_of(http.get("/readyz"))
    assert ready == {"status": "ok", "checks": {"database": "ok", "object_store": "ok"}}


def test_paper_is_in_the_public_catalog(http, paper):
    detail = json_of(http.get(f"/v1/papers/{paper.short_id}"))
    assert detail["shortId"] == paper.short_id
    assert detail["paperCid"] == paper.paper_cid
    assert detail["versionCid"] == paper.version_cid
    assert detail["title"] == paper.title
    assert [a["did"] for a in detail["authors"]][0] == paper.author.did

    listing = json_of(http.get("/v1/papers"))
    items = listing if isinstance(listing, list) else listing.get("items") or listing.get("papers")
    assert any(item.get("shortId") == paper.short_id or item.get("short_id") == paper.short_id for item in items), listing

    versions = json_of(http.get(f"/v1/papers/{paper.short_id}/versions"))
    assert paper.version_cid in str(versions)

    # The text extracted from the manuscript and the manifest that names its files.
    # (Extraction is a job reading the blob back from the store, so on s3 this also
    # proves the job runner can read objects the API wrote.)
    def extracted():
        response = http.get(f"/v1/papers/{paper.short_id}/v/1/text")
        assert response.status_code == 200, response.text
        return response.json() if response.json()["count"] else None

    text = poll(extracted, timeout=60, what="the manuscript's text to be extracted")
    assert any(paper.sentence in p["text"] for p in text["paragraphs"]), text
    manifest = json_of(http.get(f"/v1/papers/{paper.short_id}/v/1/manifest"))
    assert paper.file_cid in str(manifest)

    cite = http.get(f"/v1/papers/{paper.short_id}/cite")
    assert cite.status_code == 200, cite.text
    assert paper.short_id in cite.text or paper.title in cite.text


def test_search_and_feed_find_it(http, paper):
    found = json_of(http.get("/v1/search", params={"q": "Journey paper"}))
    assert paper.short_id in str(found), found
    feed = http.get("/v1/feeds/cs.AI")
    assert feed.status_code == 200, feed.text
    assert paper.short_id in feed.text


def test_content_is_served_verified_and_contained(node, http, paper):
    served = http.get(f"/v1/content/{paper.file_cid}")
    assert served.status_code == 200, served.text
    assert served.content == paper.pdf
    assert_bytes_match_cid(served.content, paper.file_cid)
    # Bytes from an upload are never rendered by the browser as a page of ours.
    assert served.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in served.headers["content-security-policy"]

    # A range of a file is the same bytes, so a reader can fetch a page at a time.
    part = http.get(f"/v1/content/{paper.file_cid}", headers={"Range": "bytes=0-9"})
    assert part.status_code == 206, part.text
    assert part.content == paper.pdf[:10]

    # Where the bytes physically are is the one thing the backends differ in.
    if node.storage == "fs":
        assert (node.content_dir / paper.file_cid).read_bytes() == paper.pdf
    else:
        assert node.s3 is not None
        assert node.s3.objects[paper.file_cid] == paper.pdf
        assert not (node.content_dir / paper.file_cid).exists(), "the s3 backend wrote to local disk"


def test_the_ledger_records_every_signed_record(node, http, paper):
    for cid in (paper.paper_cid, paper.version_cid, paper.manifest_cid):
        record = json_of(http.get(f"/v1/records/{cid}"))
        assert record["id"] == cid or cid in str(record)
        proof = http.get(f"/v1/records/{cid}/proof")
        assert proof.status_code == 200, proof.text

    head = json_of(http.get("/v1/sync/head"))
    assert head, head
    window = json_of(http.get("/v1/sync/range", params={"from": 1, "limit": 500}))
    entries = window if isinstance(window, list) else window.get("entries") or window.get("items") or []
    assert entries, window


def test_event_log_is_append_only_in_the_database(node, http, paper):
    """The hash chain is guarded by the database itself, not only by the application."""
    import sqlite3
    from contextlib import closing

    with closing(sqlite3.connect(node.db_path, timeout=30)) as db:
        (count,) = db.execute("SELECT COUNT(*) FROM event_log").fetchone()
        assert count >= 6
        for statement, verb in (
            ("UPDATE event_log SET seq = seq WHERE seq = 1", "UPDATE"),
            ("DELETE FROM event_log WHERE seq = 1", "DELETE"),
        ):
            # A lock timeout is also a sqlite3 error, so the message is what proves
            # it was the trigger that refused, not a busy worker.
            with pytest.raises(sqlite3.DatabaseError, match=f"append-only: {verb}"):
                db.execute(statement)
            db.rollback()
        assert db.execute("SELECT COUNT(*) FROM event_log").fetchone()[0] == count


def test_ai_pre_review_is_produced_by_the_job_runner(http, paper):
    def review():
        response = http.get(f"/v1/papers/{paper.short_id}/ai-reviews")
        return response.json() if response.status_code == 200 and response.json().get("agents") else None

    result = poll(review, timeout=90, what="the advisory AI pre-review")
    assert result["advisory"] is True
    assert result["versionCid"] == paper.version_cid
    assert {model["provider"] for model in result["models"]} == {"fake"}


def test_a_third_party_verifies_the_archive_offline(node, http, paper, tmp_path):
    archive = http.get("/v1/export/archive.car")
    assert archive.status_code == 200, archive.text
    assert archive.headers["content-type"].startswith("application/vnd.ipld.car")
    (tmp_path / "archive.car").write_bytes(archive.content)

    verified = run_command(
        [sys.executable, "-I", "-m", "scholium_cli.main", "verify", "archive.car"],
        env=clean_env(),
        cwd=tmp_path,
    )
    assert verified.returncode == 0, verified.stdout + verified.stderr
    assert "Result: VERIFIED" in verified.stdout, verified.stdout
    assert paper.short_id in verified.stdout


def test_restart_keeps_the_data(node, http, paper):
    """Stopping and starting the API again over the same data brings the same node back."""
    before = json_of(http.get(f"/v1/papers/{paper.short_id}"))
    node.api.stop()
    node.start_api()
    with node.client() as fresh:
        assert json_of(fresh.get(f"/v1/papers/{paper.short_id}")) == before
        assert fresh.get(f"/v1/content/{paper.file_cid}").content == paper.pdf
