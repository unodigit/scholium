"""``GET /v1/content/{cid}`` resolves a file's versions through an index.

The pre-listing gate (:mod:`app.modules.content.visibility`) has to know which
paper versions reference the requested bytes.  That used to be answered by
reading the body of *every* ``manifest`` record in the ledger on *every*
download, so the cost of one request grew with the size of the node.

These tests pin the property that was broken -- the work a download does does
not depend on how many manifests the log holds -- and the behaviour the index
must keep exactly as it was: who may read what.
"""

from __future__ import annotations

from contextlib import contextmanager

import threading
import types
import uuid

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key
from sqlalchemy import create_engine, delete, event, func, inspect, select, text, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app import db
from app.main import app
from app.modules import content, ledger, submissions
from app.modules.content import refs
from app.modules.content.refs import ContentRef, ContentRefProgress
from app.modules.ledger.models import EventLog
from app.modules.submissions import VersionAuthor, save_version
from app.modules.submissions.models import PaperVersion

from .test_content_listing_gate import UnlistedPaper, _bearer


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def subscribed():
    """The index's ledger subscription, as ``create_app`` leaves it.

    Other suites clear the process-wide subscriber registry, so a test that is
    about what the subscription does cannot assume it is still there.
    """
    refs.install()


@pytest.fixture
def without_subscriber():
    """Run with the index *not* subscribed to the ledger (a missed notification)."""
    refs.sync()  # whatever earlier tests left behind is not this test's business
    refs.uninstall()
    try:
        yield
    finally:
        refs.install()


@contextmanager
def sqlite_steps():
    """Count the SQLite virtual-machine instructions run on any pooled connection.

    A deterministic stand-in for "how much of the database did the request
    read": a scan over N rows executes a number of instructions proportional
    to N, whatever the machine's speed.  Yields a one-item list holding the
    running count.
    """
    steps = [0]

    def tick() -> int:
        steps[0] += 1
        return 0  # a non-zero return would abort the statement

    def on_checkout(dbapi_connection, _record, _proxy) -> None:
        dbapi_connection.set_progress_handler(tick, 1)

    def on_checkin(dbapi_connection, _record) -> None:
        dbapi_connection.set_progress_handler(None, 0)

    event.listen(db.engine, "checkout", on_checkout)
    event.listen(db.engine, "checkin", on_checkin)
    try:
        yield steps
    finally:
        event.remove(db.engine, "checkout", on_checkout)
        event.remove(db.engine, "checkin", on_checkin)


@contextmanager
def fetched_rows():
    """Count the rows every statement run on the engine hands back.

    PostgreSQL has no per-request instruction counter a client can read, so
    on it "how much of the database did the request read" is measured by the
    rows its statements return: reading every manifest in the log, which is
    the cost this index removed, makes that figure grow with the log. (The
    index itself is pinned separately, by asking the planner for the plan.)
    Yields a one-item list holding the running count.
    """
    rows = [0]

    def on_executed(_conn, cursor, _statement, _params, _context, _many) -> None:
        rows[0] += max(cursor.rowcount, 0)

    event.listen(db.engine, "after_cursor_execute", on_executed)
    try:
        yield rows
    finally:
        event.remove(db.engine, "after_cursor_execute", on_executed)


@contextmanager
def database_work():
    """The work the database does for the block, in whatever unit the dialect can count."""
    with (sqlite_steps() if db.engine.dialect.name == "sqlite" else fetched_rows()) as work:
        yield work


@contextmanager
def captured_sql():
    """Collect every statement the engine executes while the block runs."""
    statements: list[str] = []

    def on_execute(_conn, _cursor, statement, _params, _context, _many) -> None:
        statements.append(statement)

    event.listen(db.engine, "before_cursor_execute", on_execute)
    try:
        yield statements
    finally:
        event.remove(db.engine, "before_cursor_execute", on_execute)


def _download_steps(client, paper: UnlistedPaper) -> int:
    """Database work (see :func:`database_work`) one authorised download of ``paper``'s file costs."""
    url = f"/v1/content/{paper.file_cid}"
    headers = _bearer(paper.did, 2)
    # One request first: whatever is built lazily (tables, an index catching
    # up with the log) is paid here, not inside the measurement.
    assert client.get(url, headers=headers).status_code == 200
    with database_work() as steps:
        assert client.get(url, headers=headers).status_code == 200
    return steps[0]


# --------------------------------------------------------------------------- #
# The bug: a download's cost grows with the number of manifests on the node
# --------------------------------------------------------------------------- #


def test_download_cost_does_not_grow_with_the_number_of_manifests(client):
    target = UnlistedPaper(state="moderation")
    for _ in range(2):
        UnlistedPaper(state="moderation")
    few = _download_steps(client, target)

    for _ in range(60):
        UnlistedPaper(state="moderation")
    many = _download_steps(client, target)

    # A scan of the manifests would make the second figure several times the
    # first; an indexed lookup makes them equal to within a B-tree level.
    assert many <= few * 1.25, f"{few} units of database work with 3 papers, {many} with 63"


def test_a_download_does_not_read_the_ledgers_manifest_bodies(client):
    paper = UnlistedPaper(state="moderation")
    for _ in range(5):
        UnlistedPaper(state="moderation")
    url = f"/v1/content/{paper.file_cid}"
    assert client.get(url, headers=_bearer(paper.did, 2)).status_code == 200

    with captured_sql() as statements:
        assert client.get(url, headers=_bearer(paper.did, 2)).status_code == 200

    scans = [
        sql for sql in statements if "event_log.body" in sql or "event_log.raw" in sql
    ]
    assert scans == [], "a download read ledger entry bodies:\n" + "\n".join(scans)


# --------------------------------------------------------------------------- #
# Who may read what is exactly what it was
# --------------------------------------------------------------------------- #


def _store_file(tag: str) -> tuple[str, bytes]:
    data = f"%PDF-1.7 ref index test {tag} {uuid.uuid4().hex}".encode()
    blob = content.store_bytes(data, media_type="application/pdf")
    content.set_scan_status(blob.cid, content.SCAN_PASSED)
    return blob.cid, data


def _manifest_listing(owner: UnlistedPaper, *file_cids_and_sizes: tuple[str, int]) -> dict:
    """A signed ``manifest`` record naming the given files, appended to the ledger."""
    manifest = owner._sign(
        "manifest",
        {
            "files": [
                {
                    "path": f"file-{index}.pdf",
                    "cid": file_cid,
                    "size": size,
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
                for index, (file_cid, size) in enumerate(file_cids_and_sizes)
            ]
        },
    )
    ledger.append(manifest)
    return manifest


def _add_version(owner: UnlistedPaper, manifest: dict, state: str) -> str:
    """Save version 2 of ``owner``'s paper, naming ``manifest``, in ``state``."""
    with db.SessionLocal() as session:
        first = session.get(PaperVersion, owner.version_cid)
        assert first is not None
        paper_cid = first.paper_cid
    version = owner._sign(
        "paper.version",
        {
            "paper": paper_cid,
            "n": 2,
            "title": "Second version",
            "abstract": "Shares a file with another paper.",
            "authors": [{"did": owner.did, "position": 1}],
            "manifest": manifest["id"],
            "licence": "CC-BY-4.0",
        },
        prev=owner.version_cid,
    )
    ledger.append(version)
    save_version(
        version_cid=version["id"],
        paper_cid=paper_cid,
        n=2,
        title="Second version",
        abstract="Shares a file with another paper.",
        manifest_cid=manifest["id"],
        licence="CC-BY-4.0",
        prev_cid=owner.version_cid,
        authors=(VersionAuthor(owner.did, 1, ()),),
        state=state,
    )
    return version["id"]


def test_a_file_named_by_a_manifest_no_version_references_is_not_public(client):
    # Between a manifest being accepted and a version naming it, the bytes are
    # already pre-listing: only a moderator may read them.  The index must not
    # turn "a manifest lists it, no version does yet" into "nothing lists it".
    owner = UnlistedPaper(state="moderation")
    file_cid, data = _store_file("orphan manifest")
    _manifest_listing(owner, (file_cid, len(data)))
    moderator = did_key_from_signing_key(SigningKey.generate())

    assert client.get(f"/v1/content/{file_cid}").status_code == 404
    assert client.get(f"/v1/content/{file_cid}", headers=_bearer(owner.did, 2)).status_code == 404
    assert client.get(f"/v1/content/{file_cid}", headers=_bearer(moderator, 4)).status_code == 200


def test_a_file_two_versions_share_is_public_once_either_is_listed(client):
    first = UnlistedPaper(state="moderation")
    second = UnlistedPaper(state="moderation")
    manifest = _manifest_listing(second, (first.file_cid, len(first.manuscript)))
    _add_version(second, manifest, state="moderation")
    url = f"/v1/content/{first.file_cid}"

    # Unlisted everywhere: anonymous callers are refused, either paper's author
    # may read, and a stranger may not.
    stranger = did_key_from_signing_key(SigningKey.generate())
    assert client.get(url).status_code == 404
    assert client.get(url, headers=_bearer(first.did, 2)).status_code == 200
    assert client.get(url, headers=_bearer(second.did, 2)).status_code == 200
    assert client.get(url, headers=_bearer(stranger, 2)).status_code == 404

    # One referencing version listed: the bytes are public.
    first.list_it()
    assert client.get(url).status_code == 200


def test_a_listed_second_version_makes_the_shared_file_public(client):
    first = UnlistedPaper(state="moderation")
    second = UnlistedPaper(state="moderation")
    manifest = _manifest_listing(second, (first.file_cid, len(first.manuscript)))
    _add_version(second, manifest, state=submissions.LISTED)

    assert client.get(f"/v1/content/{first.file_cid}").status_code == 200


# --------------------------------------------------------------------------- #
# The index itself
# --------------------------------------------------------------------------- #


def _indexed(file_cid: str) -> set[str]:
    """The manifests the index says list ``file_cid``."""
    with db.SessionLocal() as session:
        return set(
            session.execute(
                select(ContentRef.manifest_cid).where(ContentRef.content_cid == file_cid)
            ).scalars()
        )


def _progress() -> int:
    with db.SessionLocal() as session:
        return session.execute(select(ContentRefProgress.last_seq)).scalar_one()


def _newest_manifest_seq() -> int:
    with db.SessionLocal() as session:
        return session.execute(
            select(EventLog.seq)
            .where(EventLog.record_type == "manifest")
            .order_by(EventLog.seq.desc())
            .limit(1)
        ).scalar_one()


def _wipe_index() -> None:
    """Put the index back to what a node has before the index existed."""
    with db.SessionLocal() as session:
        session.execute(delete(ContentRef))
        session.execute(update(ContentRefProgress).values(last_seq=0))
        session.commit()


def test_the_index_names_the_manifest_that_lists_a_file():
    paper = UnlistedPaper(state="moderation")

    # Indexed by the ledger subscriber as the record was appended: no download
    # and no explicit sync has happened.
    assert _indexed(paper.file_cid) == {paper.manifest_cid}


def test_the_record_type_the_index_follows_is_the_one_submissions_owns():
    assert refs.MANIFEST_RECORD_TYPE == submissions.MANIFEST_TYPE


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"files": [{"cid": "a"}, {"cid": "b"}]}, ["a", "b"]),
        ({"files": [{"cid": "a"}, {"cid": "a", "path": "other"}]}, ["a"]),  # one reference
        ({"files": [{"cid": "b"}, {"cid": "a"}, {"cid": "b"}]}, ["b", "a"]),  # first-seen order
        ({"files": []}, []),
        ({"files": "a"}, []),
        ({"files": {"cid": "a"}}, []),
        ({"files": [None, 3, "a", ["a"]]}, []),
        ({"files": [{"cid": 7}, {"cid": ""}, {"cid": None}, {"path": "x"}]}, []),
        ({"files": [{"cid": ["a"]}, {"cid": "a"}]}, ["a"]),
        ({}, []),
        (["a"], []),
        ("a", []),
        (None, []),
    ],
)
def test_only_well_formed_file_entries_name_a_file(body, expected):
    # What the scan this index replaced counted as "the manifest lists it".
    assert refs.file_cids(body) == expected


def test_install_is_idempotent():
    refs.install()
    before = ledger.subscriber_count(refs.MANIFEST_RECORD_TYPE)

    refs.install()
    refs.install()

    assert ledger.subscriber_count(refs.MANIFEST_RECORD_TYPE) == before


def test_the_versions_a_manifest_names_are_looked_up_by_index():
    refs.ensure_tables()

    columns = [index["column_names"] for index in inspect(db.engine).get_indexes("paper_versions")]
    assert ["manifest_cid"] in columns

    lookup = "SELECT version_cid, state FROM paper_versions WHERE manifest_cid IN ('a', 'b')"
    if db.engine.dialect.name == "postgresql":
        with db.engine.begin() as connection:
            # On a table this small the planner rightly prefers to read it
            # whole. With sequential scans switched off it uses an index
            # whenever one can serve the lookup, and a scan means none can.
            connection.execute(text("SET LOCAL enable_seqscan = off"))
            plan = " ".join(row[0] for row in connection.execute(text(f"EXPLAIN {lookup}")))
        assert "Index" in plan, plan
        assert "Seq Scan" not in plan, plan
        return

    with db.engine.connect() as connection:
        plan = " ".join(row[3] for row in connection.execute(text(f"EXPLAIN QUERY PLAN {lookup}")))
    assert "USING INDEX" in plan or "USING COVERING INDEX" in plan, plan
    assert "SCAN" not in plan, plan


# --------------------------------------------------------------------------- #
# Backfill: manifests that predate the index
# --------------------------------------------------------------------------- #


def test_startup_backfills_manifests_logged_before_the_index_existed(client):
    paper = UnlistedPaper(state="moderation")
    _wipe_index()  # a node upgraded from a build without the index
    assert _indexed(paper.file_cid) == set()

    content.on_startup()

    assert _indexed(paper.file_cid) == {paper.manifest_cid}
    assert _progress() == _newest_manifest_seq()
    assert client.get(f"/v1/content/{paper.file_cid}").status_code == 404
    assert client.get(f"/v1/content/{paper.file_cid}", headers=_bearer(paper.did, 2)).status_code == 200


def test_backfill_reads_a_long_log_in_pages(without_subscriber, monkeypatch):
    monkeypatch.setattr(refs, "PAGE_SIZE", 2)
    papers = [UnlistedPaper(state="moderation") for _ in range(5)]

    with captured_sql() as statements:
        indexed = refs.sync()

    assert indexed == 5
    # One transaction per page of two: 2 + 2 + 1.
    assert sum("UPDATE content_ref_progress" in sql for sql in statements) == 6
    assert _progress() == _newest_manifest_seq()
    for paper in papers:
        assert _indexed(paper.file_cid) == {paper.manifest_cid}


def test_an_index_that_is_current_does_no_work():
    UnlistedPaper(state="moderation")
    refs.sync()

    with captured_sql() as statements:
        assert refs.sync() == 0

    assert not [sql for sql in statements if sql.lstrip().upper().startswith(("UPDATE", "INSERT"))]
    assert not [sql for sql in statements if "event_log.body" in sql]


def test_catching_up_twice_does_not_index_a_manifest_twice(without_subscriber):
    paper = UnlistedPaper(state="moderation")

    assert refs.sync() == 1
    assert refs.sync() == 0
    assert _indexed(paper.file_cid) == {paper.manifest_cid}


def test_a_failed_startup_backfill_does_not_stop_the_node(monkeypatch, caplog):
    def busy() -> int:
        raise OperationalError("SELECT 1", {}, Exception("database is locked"))

    monkeypatch.setattr(refs, "backfill", busy)

    content.on_startup()  # must not raise

    assert "could not backfill" in caplog.text
    assert ledger.subscriber_count(refs.MANIFEST_RECORD_TYPE) >= 1


# --------------------------------------------------------------------------- #
# The gate never trusts a notification it may not have received
# --------------------------------------------------------------------------- #


def test_a_manifest_the_subscriber_never_saw_still_gates_its_file(client, without_subscriber):
    # The registry was cleared (other suites do), or the subscriber was down.
    paper = UnlistedPaper(state="moderation")
    assert _indexed(paper.file_cid) == set()

    assert client.get(f"/v1/content/{paper.file_cid}").status_code == 404
    assert client.get(f"/v1/content/{paper.file_cid}", headers=_bearer(paper.did, 2)).status_code == 200
    assert _indexed(paper.file_cid) == {paper.manifest_cid}


def test_a_subscriber_that_fails_cannot_leave_a_file_public(client, monkeypatch):
    def broken() -> int:
        raise RuntimeError("the index is unavailable")

    # The ledger logs a subscriber that raises and carries on, so the record is
    # appended and the index is behind.  (A scoped patch: ``monkeypatch.undo()``
    # would also revert the autouse fixtures' patches, such as CONTENT_DIR.)
    with monkeypatch.context() as patch:
        patch.setattr(refs, "sync", broken)
        paper = UnlistedPaper(state="moderation")
    assert _indexed(paper.file_cid) == set()

    # An anonymous caller is refused, the author is not: the gate caught the
    # index up itself rather than reading "no manifest lists this file".
    assert client.get(f"/v1/content/{paper.file_cid}").status_code == 404
    assert client.get(f"/v1/content/{paper.file_cid}", headers=_bearer(paper.did, 2)).status_code == 200


def test_a_version_saved_before_its_manifest_gates_the_file_once_the_manifest_is_logged(client):
    owner = UnlistedPaper(state="moderation")
    file_cid, data = _store_file("late manifest")
    manifest = owner._sign(
        "manifest",
        {
            "files": [
                {
                    "path": "late.pdf",
                    "cid": file_cid,
                    "size": len(data),
                    "mediaType": "application/pdf",
                    "role": "manuscript",
                }
            ]
        },
    )
    _add_version(owner, manifest, state="moderation")  # names a manifest not yet appended
    url = f"/v1/content/{file_cid}"
    # Nothing lists the bytes yet, so they are public: as before.
    assert client.get(url).status_code == 200

    ledger.append(manifest)

    assert client.get(url).status_code == 404
    assert client.get(url, headers=_bearer(owner.did, 2)).status_code == 200


def test_a_reset_progress_row_rebuilds_the_index_without_failing(client):
    paper = UnlistedPaper(state="moderation")
    with db.SessionLocal() as session:
        session.execute(delete(ContentRefProgress))  # an operator forcing a rebuild
        session.commit()

    # The rows are all still there; indexing them again must not trip over them.
    assert client.get(f"/v1/content/{paper.file_cid}").status_code == 404
    assert _indexed(paper.file_cid) == {paper.manifest_cid}
    assert _progress() == _newest_manifest_seq()


# --------------------------------------------------------------------------- #
# Concurrent catch-up
# --------------------------------------------------------------------------- #


def test_concurrent_catch_up_indexes_each_manifest_exactly_once(without_subscriber, monkeypatch):
    monkeypatch.setattr(refs, "PAGE_SIZE", 2)
    papers = [UnlistedPaper(state="moderation") for _ in range(6)]
    counts: list[int] = []
    errors: list[BaseException] = []
    start = threading.Barrier(4)

    def worker() -> None:
        try:
            start.wait()
            counts.append(refs.sync())
        except BaseException as exc:  # noqa: BLE001 - reported below
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    # Every page was claimed by exactly one caller.
    assert sum(counts) == 6
    assert _progress() == _newest_manifest_seq()
    for paper in papers:
        assert _indexed(paper.file_cid) == {paper.manifest_cid}


# --------------------------------------------------------------------------- #
# One upsert, in each dialect's own INSERT ... ON CONFLICT
# --------------------------------------------------------------------------- #

#: An engine URL per dialect.  ``create_engine`` does not connect, which is all
#: that is needed to build (and compile) the statement a session would run.
_DIALECT_URLS = {
    "postgresql": "postgresql+psycopg://scholium@db.invalid/scholium",
    "sqlite": "sqlite://",
}

_ON_CONFLICT = (
    "ON CONFLICT (content_cid, manifest_cid) DO UPDATE SET "
    "path = excluded.path, media_type = excluded.media_type, role = excluded.role"
)


def _upsert_for(dialect: str):
    """The statement :func:`refs._insert_references` builds for a ``dialect`` session."""
    session = Session(bind=create_engine(_DIALECT_URLS[dialect]))
    statement = refs._insert_references(session)
    return statement, statement.compile(dialect=session.get_bind().dialect)


@pytest.mark.parametrize("dialect", sorted(_DIALECT_URLS))
def test_each_dialect_upserts_with_its_own_insert_on_conflict(dialect):
    statement, compiled = _upsert_for(dialect)

    # The dialect's own construct: SQLAlchemy's generic insert has no ON CONFLICT.
    assert type(statement).__module__ == f"sqlalchemy.dialects.{dialect}.dml"
    sql = str(compiled)
    assert sql.startswith("INSERT INTO content_refs (content_cid, manifest_cid, path, media_type, role)")
    assert sql.rstrip().endswith(_ON_CONFLICT), sql


def test_both_dialects_take_the_same_rows_and_conflict_on_the_same_key():
    _, postgres = _upsert_for("postgresql")
    _, sqlite = _upsert_for("sqlite")

    # What differs between the two is only the placeholder syntax: one list of
    # rows feeds either statement, and both resolve a clash on the primary key
    # by refreshing the same three columns -- so the same rows, and the same
    # counts, come out.
    assert sorted(postgres.params) == sorted(sqlite.params)
    assert _ON_CONFLICT in str(postgres) and _ON_CONFLICT in str(sqlite)


def test_a_dialect_with_no_upsert_here_gets_a_plain_insert():
    unknown = types.SimpleNamespace(
        get_bind=lambda: types.SimpleNamespace(dialect=types.SimpleNamespace(name="mssql"))
    )

    statement = refs._insert_references(unknown)

    assert type(statement).__module__ == "sqlalchemy.sql.dml"
    assert "ON CONFLICT" not in str(statement)


def _reference_count() -> int:
    with db.SessionLocal() as session:
        return session.execute(select(func.count()).select_from(ContentRef)).scalar_one()


def _rows_of(*papers: UnlistedPaper) -> set[tuple]:
    """``(file, manifest, path, media type, role)`` for each paper's index row."""
    with db.SessionLocal() as session:
        return set(
            session.execute(
                select(
                    ContentRef.content_cid,
                    ContentRef.manifest_cid,
                    ContentRef.path,
                    ContentRef.media_type,
                    ContentRef.role,
                ).where(ContentRef.content_cid.in_([paper.file_cid for paper in papers]))
            ).all()
        )


def _reset_manifest_mark(seq: int) -> None:
    with db.SessionLocal() as session:
        session.execute(update(ContentRefProgress).values(last_seq=seq))
        session.commit()


def test_indexing_again_over_existing_rows_counts_and_stores_what_the_first_pass_did(
    without_subscriber,
):
    before = _progress()
    papers = [UnlistedPaper(state="moderation") for _ in range(3)]
    rows_before = _reference_count()

    first = refs.sync()
    rows_after_insert = _reference_count()
    stored = _rows_of(*papers)

    # Put the mark back so the same manifests are read again over rows that
    # are already there: the path an INSERT alone cannot take.
    _reset_manifest_mark(before)
    second = refs.sync()

    assert first == second == 3
    assert rows_after_insert - rows_before == 3  # one file per paper
    assert _reference_count() == rows_after_insert  # no duplicates, no losses
    assert _rows_of(*papers) == stored
    assert _progress() == _newest_manifest_seq()


def test_the_upsert_fills_in_the_metadata_of_rows_that_predate_it(without_subscriber):
    before = _progress()
    paper = UnlistedPaper(state="moderation")
    assert refs.sync() == 1
    # A row as the first build of the index left it: the file and manifest, no metadata.
    with db.SessionLocal() as session:
        session.execute(
            update(ContentRef)
            .where(ContentRef.content_cid == paper.file_cid)
            .values(path=None, media_type=None, role=None)
        )
        session.commit()
    assert _rows_of(paper) == {(paper.file_cid, paper.manifest_cid, None, None, None)}

    _reset_manifest_mark(before)
    assert refs.sync() == 1

    assert _rows_of(paper) == {
        (paper.file_cid, paper.manifest_cid, "main.pdf", "application/pdf", "manuscript")
    }
