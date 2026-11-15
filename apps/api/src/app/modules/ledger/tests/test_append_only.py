"""Tests for the append-only triggers on ``event_log`` (feature 13).

Covers: UPDATE and DELETE statements are rejected with an integrity error
whose message says the log is append-only (raw SQL, Core and ORM; one row and
many; any column, ``seq`` included; upsert); ``INSERT OR REPLACE`` -- the
back door to deleting a row -- is rejected too, while a plain duplicate CID is
still an ``IntegrityError``; appending is unaffected; a rejected statement
leaves every row untouched; installation is idempotent and upgrades a table
created before the triggers existed (via ``ensure_table`` and via
``create_all``); the live database has the triggers once the ledger is used.

Isolation note: the mutation tests run against a throwaway SQLite file
(``sandbox``), not the worker's shared ``event_log``.  They *expect* every
mutation to fail, but a regression must not be able to rewrite or delete the
rows other tests (and the chain verifier) rely on.  Only the "live database"
group touches the real log, and only to attempt mutations the triggers
reject.
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime

import pytest
from sqlalchemy import create_engine, delete, insert, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app import db
from app.modules import ledger
from app.modules.ledger import (
    APPEND_ONLY_TRIGGERS,
    DELETE_REJECTED,
    REPLACE_REJECTED,
    UPDATE_REJECTED,
    EventLog,
    GENESIS_PREV_HASH,
    append_only_triggers_installed,
    compute_entry_hash,
    install_append_only_triggers,
)
from app.modules.ledger import models as ledger_models

AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"
TRIGGER_NAMES = sorted(APPEND_ONLY_TRIGGERS)

INSERT_SQL = text(
    "INSERT INTO event_log (record_cid, record_type, author_did, body, raw, "
    "prev_hash, entry_hash, received_at, origin_node) VALUES "
    "(:cid, 'test.ledger.append_only', :author, '{}', :raw, :prev, :entry, "
    "'2026-11-15 00:00:00', 'did:key:node')"
)


def new_engine(path):
    return create_engine(f"sqlite:///{path}", future=True)


@pytest.fixture
def sandbox(tmp_path):
    """An engine over a scratch database whose ``event_log`` has the triggers."""
    engine = new_engine(tmp_path / "sandbox.db")
    EventLog.__table__.create(bind=engine)
    install_append_only_triggers(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def untriggered(tmp_path):
    """A scratch database whose ``event_log`` predates the triggers."""
    engine = new_engine(tmp_path / "untriggered.db")
    EventLog.__table__.create(bind=engine)
    yield engine
    engine.dispose()


def add_row(engine, *, cid: str | None = None) -> str:
    """Insert one row with raw SQL and return its record CID."""
    cid = cid or f"bafyreiappendonly{uuid.uuid4().hex}"
    raw = f"canonical {cid}".encode()
    with engine.begin() as connection:
        connection.execute(
            INSERT_SQL,
            {
                "cid": cid,
                "author": AUTHOR,
                "raw": raw,
                "prev": GENESIS_PREV_HASH,
                "entry": compute_entry_hash(GENESIS_PREV_HASH, cid, raw),
            },
        )
    return cid


def snapshot(engine) -> list[tuple]:
    """Every row of ``event_log``, in seq order, as plain tuples."""
    with engine.connect() as connection:
        return [tuple(row) for row in connection.execute(text("SELECT * FROM event_log ORDER BY seq"))]


def trigger_names(engine) -> list[str]:
    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'event_log'")
        )
        return sorted(row[0] for row in rows)


def make_envelope():
    tag = uuid.uuid4().hex
    return {
        "v": 1,
        "type": "test.ledger.append_only",
        "author": AUTHOR,
        "created": "2026-11-15T00:00:00Z",
        "prev": None,
        "body": {"tag": tag},
        "proofs": [],
    }


# --------------------------------------------------------------------------- #
# UPDATE is rejected
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "assignment",
    [
        "body = '{\"forged\": true}'",
        "raw = x'00'",
        "record_cid = 'bafyreiforged'",
        "record_type = 'forged.type'",
        "author_did = 'did:key:forged'",
        "prev_hash = x'00'",
        "entry_hash = x'00'",
        "received_at = '1999-01-01 00:00:00'",
        "origin_node = 'did:key:forged'",
        "seq = seq + 1000",
        "seq = seq",  # even a no-op assignment is an UPDATE
    ],
)
def test_update_of_any_column_is_rejected(sandbox, assignment):
    add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(text(f"UPDATE event_log SET {assignment}"))

    assert UPDATE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_the_error_is_a_sqlite_integrity_error_with_the_append_only_message(sandbox):
    add_row(sandbox)

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(text("UPDATE event_log SET origin_node = 'x'"))

    assert isinstance(excinfo.value.orig, sqlite3.IntegrityError)
    assert str(excinfo.value.orig) == UPDATE_REJECTED
    assert "append-only" in UPDATE_REJECTED


def test_updating_many_rows_changes_none_of_them(sandbox):
    for _ in range(5):
        add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError):
        with sandbox.begin() as connection:
            connection.execute(text("UPDATE event_log SET origin_node = 'did:key:forged'"))

    assert snapshot(sandbox) == before


def test_a_where_clause_matching_nothing_is_not_an_error(sandbox):
    # Row-level semantics: the trigger guards rows that exist, so an UPDATE or
    # DELETE that touches no row is simply a no-op, as in any database.
    add_row(sandbox)
    before = snapshot(sandbox)

    with sandbox.begin() as connection:
        connection.execute(text("UPDATE event_log SET origin_node = 'x' WHERE seq = -1"))
        connection.execute(text("DELETE FROM event_log WHERE seq = -1"))

    assert snapshot(sandbox) == before


def test_core_update_is_rejected(sandbox):
    add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(update(EventLog.__table__).values(body={"forged": True}))

    assert UPDATE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_orm_attribute_change_is_rejected_on_flush(sandbox):
    cid = add_row(sandbox)
    before = snapshot(sandbox)

    with Session(sandbox) as session:
        row = session.execute(select(EventLog).where(EventLog.record_cid == cid)).scalar_one()
        row.origin_node = "did:key:forged"
        with pytest.raises(IntegrityError) as excinfo:
            session.commit()
        session.rollback()

    assert UPDATE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_upsert_cannot_be_used_to_update_a_row(sandbox):
    cid = add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError):
        with sandbox.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO event_log (record_cid, record_type, author_did, body, raw, "
                    "prev_hash, entry_hash, received_at, origin_node) VALUES "
                    "(:cid, 'x', 'x', '{}', x'00', x'00', x'00', '2026-11-15 00:00:00', 'x') "
                    "ON CONFLICT (record_cid) DO UPDATE SET origin_node = 'did:key:forged'"
                ),
                {"cid": cid},
            )

    assert snapshot(sandbox) == before


# --------------------------------------------------------------------------- #
# DELETE is rejected
# --------------------------------------------------------------------------- #


def test_delete_of_one_row_is_rejected(sandbox):
    cid = add_row(sandbox)
    add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(text("DELETE FROM event_log WHERE record_cid = :cid"), {"cid": cid})

    assert DELETE_REJECTED in str(excinfo.value)
    assert isinstance(excinfo.value.orig, sqlite3.IntegrityError)
    assert snapshot(sandbox) == before


def test_delete_of_every_row_is_rejected(sandbox):
    for _ in range(4):
        add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(text("DELETE FROM event_log"))

    assert DELETE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_core_delete_is_rejected(sandbox):
    add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(delete(EventLog.__table__))

    assert DELETE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_orm_delete_is_rejected_on_flush(sandbox):
    cid = add_row(sandbox)
    before = snapshot(sandbox)

    with Session(sandbox) as session:
        row = session.execute(select(EventLog).where(EventLog.record_cid == cid)).scalar_one()
        session.delete(row)
        with pytest.raises(IntegrityError) as excinfo:
            session.commit()
        session.rollback()

    assert DELETE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_a_rejected_statement_does_not_poison_later_appends(sandbox):
    first = add_row(sandbox)

    with pytest.raises(IntegrityError):
        with sandbox.begin() as connection:
            connection.execute(text("DELETE FROM event_log"))

    second = add_row(sandbox)
    assert [row[1] for row in snapshot(sandbox)] == [first, second]


# --------------------------------------------------------------------------- #
# INSERT OR REPLACE is the third way to delete a row
# --------------------------------------------------------------------------- #


def test_insert_or_replace_on_an_existing_cid_is_rejected(sandbox):
    # SQLite resolves REPLACE by deleting the conflicting row *without*
    # firing DELETE triggers (recursive_triggers is off), so the BEFORE INSERT
    # guard is what keeps the original row.
    cid = add_row(sandbox)
    before = snapshot(sandbox)

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(
                text(
                    "INSERT OR REPLACE INTO event_log (record_cid, record_type, author_did, "
                    "body, raw, prev_hash, entry_hash, received_at, origin_node) VALUES "
                    "(:cid, 'x', 'x', '{}', x'00', x'00', x'00', '2026-11-15 00:00:00', 'x')"
                ),
                {"cid": cid},
            )

    assert REPLACE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_insert_or_replace_on_an_existing_seq_is_rejected(sandbox):
    add_row(sandbox)
    before = snapshot(sandbox)
    seq = before[0][0]

    with pytest.raises(IntegrityError) as excinfo:
        with sandbox.begin() as connection:
            connection.execute(
                text(
                    "INSERT OR REPLACE INTO event_log (seq, record_cid, record_type, author_did, "
                    "body, raw, prev_hash, entry_hash, received_at, origin_node) VALUES "
                    "(:seq, 'bafyreiother', 'x', 'x', '{}', x'00', x'00', x'00', "
                    "'2026-11-15 00:00:00', 'x')"
                ),
                {"seq": seq},
            )

    assert REPLACE_REJECTED in str(excinfo.value)
    assert snapshot(sandbox) == before


def test_a_plain_duplicate_cid_is_still_an_integrity_error(sandbox):
    cid = add_row(sandbox)

    with pytest.raises(IntegrityError):
        add_row(sandbox, cid=cid)

    assert [row[1] for row in snapshot(sandbox)] == [cid]


# --------------------------------------------------------------------------- #
# Appending still works
# --------------------------------------------------------------------------- #


def test_inserts_are_unaffected_and_seq_keeps_increasing(sandbox):
    cids = [add_row(sandbox) for _ in range(10)]

    rows = snapshot(sandbox)
    assert [row[1] for row in rows] == cids
    assert [row[0] for row in rows] == list(range(1, 11))


def test_seq_is_never_reused_after_a_rejected_delete(sandbox):
    add_row(sandbox)
    with pytest.raises(IntegrityError):
        with sandbox.begin() as connection:
            connection.execute(text("DELETE FROM event_log"))
    add_row(sandbox)

    assert [row[0] for row in snapshot(sandbox)] == [1, 2]


def test_orm_inserts_do_not_trip_the_triggers(sandbox):
    with Session(sandbox) as session:
        session.add(
            EventLog(
                record_cid="bafyreiorminsert",
                record_type="test.ledger.append_only",
                author_did=AUTHOR,
                body={"ok": True},
                raw=b"raw",
                prev_hash=GENESIS_PREV_HASH,
                entry_hash=compute_entry_hash(GENESIS_PREV_HASH, "bafyreiorminsert", b"raw"),
                received_at=datetime(2026, 11, 15),
                origin_node="did:key:node",
            )
        )
        session.commit()

    assert len(snapshot(sandbox)) == 1


# --------------------------------------------------------------------------- #
# Installation
# --------------------------------------------------------------------------- #


def test_installation_is_idempotent(sandbox):
    assert trigger_names(sandbox) == TRIGGER_NAMES

    install_append_only_triggers(sandbox)
    install_append_only_triggers(sandbox)

    assert trigger_names(sandbox) == TRIGGER_NAMES
    assert append_only_triggers_installed(sandbox)


def test_installing_through_a_connection_works(tmp_path):
    # The form the ``create_all`` event uses.  (pysqlite auto-commits DDL, so
    # whether the caller's transaction is later committed or rolled back does
    # not change the outcome; installation is idempotent anyway.)
    engine = new_engine(tmp_path / "connection.db")
    EventLog.__table__.create(bind=engine)

    with engine.connect() as connection:
        install_append_only_triggers(connection)
        assert append_only_triggers_installed(connection)

    assert trigger_names(engine) == TRIGGER_NAMES
    engine.dispose()


def test_a_table_created_before_the_triggers_can_be_mutated_until_they_are_installed(untriggered):
    # Documents what installation protects against, and proves the other
    # tests are really exercising the triggers and not some other constraint.
    assert not append_only_triggers_installed(untriggered)
    cid = add_row(untriggered)

    with untriggered.begin() as connection:
        connection.execute(text("UPDATE event_log SET origin_node = 'changed'"))
    assert snapshot(untriggered)[0][-1] == "changed"

    install_append_only_triggers(untriggered)
    assert append_only_triggers_installed(untriggered)

    with pytest.raises(IntegrityError):
        with untriggered.begin() as connection:
            connection.execute(text("DELETE FROM event_log WHERE record_cid = :cid"), {"cid": cid})
    assert len(snapshot(untriggered)) == 1


def test_create_all_installs_the_triggers_on_a_fresh_database(tmp_path):
    engine = new_engine(tmp_path / "fresh.db")

    db.Base.metadata.create_all(bind=engine)

    assert append_only_triggers_installed(engine)
    assert trigger_names(engine) == TRIGGER_NAMES
    add_row(engine)
    with pytest.raises(IntegrityError):
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM event_log"))
    engine.dispose()


def test_create_all_upgrades_an_existing_table_in_place(untriggered):
    # The app's startup ``create_all`` skips a table that already exists, yet
    # must still protect a database created before this feature.
    cid = add_row(untriggered)
    assert trigger_names(untriggered) == []

    db.Base.metadata.create_all(bind=untriggered)

    assert trigger_names(untriggered) == TRIGGER_NAMES
    assert [row[1] for row in snapshot(untriggered)] == [cid]
    with pytest.raises(IntegrityError):
        with untriggered.begin() as connection:
            connection.execute(text("UPDATE event_log SET origin_node = 'x'"))


def test_create_all_for_other_tables_does_not_require_event_log(tmp_path):
    from sqlalchemy import Column, Integer, MetaData, Table
    from app.modules.ledger.triggers import install_on_create_all

    engine = new_engine(tmp_path / "other.db")
    metadata = MetaData()
    Table("unrelated", metadata, Column("id", Integer, primary_key=True))
    install_on_create_all(metadata)

    metadata.create_all(bind=engine)  # no event_log here: must not raise

    assert trigger_names(engine) == []
    engine.dispose()


@pytest.fixture
def swapped_engine(monkeypatch):
    """Point the ledger at a scratch engine so ``ensure_table`` re-runs on it."""

    def swap(engine):
        # ``SessionLocal`` is bound to the original engine, so swap it too or
        # ``append``/``entries`` would still read and write the live log.
        monkeypatch.setattr(db, "engine", engine)
        monkeypatch.setattr(
            db, "SessionLocal", sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
        )
        monkeypatch.setattr(ledger_models, "_table_engine", None)

    return swap


def test_ensure_table_creates_the_table_with_its_triggers(tmp_path, swapped_engine):
    engine = new_engine(tmp_path / "ensure_fresh.db")
    swapped_engine(engine)

    ledger.ensure_table()

    assert append_only_triggers_installed(engine)
    engine.dispose()


def test_ensure_table_upgrades_an_existing_table_in_place(untriggered, swapped_engine):
    cid = add_row(untriggered)
    swapped_engine(untriggered)

    ledger.ensure_table()

    assert trigger_names(untriggered) == TRIGGER_NAMES
    assert [row[1] for row in snapshot(untriggered)] == [cid]


def test_append_writes_through_the_triggers_on_a_scratch_database(untriggered, swapped_engine):
    swapped_engine(untriggered)

    first = ledger.append(make_envelope())
    second = ledger.append(make_envelope())

    assert append_only_triggers_installed(untriggered)
    assert (first.seq, second.seq) == (1, 2)
    assert second.prev_hash == first.entry_hash
    assert ledger.verify_log(ledger.entries()) is None


# --------------------------------------------------------------------------- #
# The live database
# --------------------------------------------------------------------------- #


def test_the_live_event_log_has_the_triggers_once_the_ledger_is_used():
    ledger.append(make_envelope())

    assert append_only_triggers_installed(db.engine)


def test_a_live_entry_cannot_be_updated_or_deleted():
    entry = ledger.append(make_envelope())

    with pytest.raises(IntegrityError) as updating:
        with db.engine.begin() as connection:
            connection.execute(
                text("UPDATE event_log SET body = '{}' WHERE seq = :seq"), {"seq": entry.seq}
            )
    assert UPDATE_REJECTED in str(updating.value)

    with pytest.raises(IntegrityError) as deleting:
        with db.engine.begin() as connection:
            connection.execute(text("DELETE FROM event_log WHERE seq = :seq"), {"seq": entry.seq})
    assert DELETE_REJECTED in str(deleting.value)

    stored = ledger.entry_by_cid(entry.record_cid)
    assert stored is not None
    assert stored.to_dict() == entry.to_dict()


def test_an_orm_session_cannot_rewrite_a_live_entry():
    entry = ledger.append(make_envelope())

    with db.SessionLocal() as session:
        row = session.get(EventLog, entry.seq)
        row.body = {"forged": True}
        with pytest.raises(IntegrityError) as excinfo:
            session.commit()
        session.rollback()
    assert UPDATE_REJECTED in str(excinfo.value)

    with db.SessionLocal() as session:
        session.delete(session.get(EventLog, entry.seq))
        with pytest.raises(IntegrityError) as excinfo:
            session.commit()
        session.rollback()
    assert DELETE_REJECTED in str(excinfo.value)

    assert ledger.entry_by_cid(entry.record_cid).body == entry.body


def test_a_duplicate_append_still_raises_integrity_error():
    envelope = make_envelope()
    ledger.append(envelope)

    with pytest.raises(IntegrityError):
        ledger.append(envelope)
