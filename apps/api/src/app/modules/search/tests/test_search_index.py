"""Tests for saving listed versions into ``search_fts`` (feature 85).

Covers: the FTS5 table and its columns; a version's title, abstract and text
landing in the index when it is listed (and only then); ``held`` and
``rejected`` removing it and re-listing restoring it with current text; the
ledger's ``paper.version`` subscription as a path of its own; idempotence and
concurrency; the repair pass; and discovery by the module loader.

The two triggers are exercised separately.  ``save_version`` and
``transition_version`` both emit ``version.state_changed``, so a test of the
ledger path unsubscribes the state handler first and vice versa -- otherwise
either path could be credited with the other's work.

Isolation: tests in a worker share one database, so every test uses fresh
random cids and asserts on its own rows, never on table totals.
"""

from __future__ import annotations

import sys
import threading
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from nacl.signing import SigningKey
from scholium_record_core import compute_record_id, did_key_from_signing_key, sign_record
from sqlalchemy import text

from app import db, module_loader
from app.modules import checks, ledger, search
from app.modules.search import index as search_index
from app.modules.search import subscribers
from app.modules.submissions import (
    AWAITING_CONSENT,
    HELD,
    LISTED,
    MODERATION,
    REJECTED,
    SCANNING,
    VersionStateChanged,
    clear_state_changed_subscribers,
    emit_state_changed,
    get_version,
    save_version,
    state_changed_subscriber_count,
    transition_version,
    unsubscribe_version_state_changed,
)

PAPER_VERSION_TYPE = "paper.version"
AUTHOR = "did:key:z6MkhaKgMu9Ub4SpT3V9RbtCib6aRumXZY1JdHMzCCZK7pBb"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def new_cid() -> str:
    """A real, unique dag-cbor record id, as a version's cid is."""
    return compute_record_id(
        {
            "v": 1,
            "type": "test.search",
            "author": AUTHOR,
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        }
    )


def make_version(
    *,
    version_cid: str | None = None,
    paper_cid: str | None = None,
    n: int = 1,
    title: str = "A study of dormant pulsars",
    abstract: str = "We observe pulsars.",
    state: str = AWAITING_CONSENT,
) -> str:
    """Save a version directly and return its cid."""
    cid = version_cid or new_cid()
    save_version(
        version_cid=cid,
        paper_cid=paper_cid or f"paper-{uuid.uuid4().hex}",
        n=n,
        title=title,
        abstract=abstract,
        manifest_cid=f"bafkreimanifest{uuid.uuid4().hex}",
        licence="CC-BY-4.0",
        prev_cid=None,
        state=state,
    )
    return cid


def list_version(cid: str) -> None:
    transition_version(cid, SCANNING)
    transition_version(cid, MODERATION)
    transition_version(cid, LISTED)


def match(query: str) -> list[str]:
    """The version cids ``search_fts`` finds for an FTS5 ``query``."""
    with db.engine.connect() as connection:
        return [
            row[0]
            for row in connection.execute(
                text("SELECT version_cid FROM search_fts WHERE search_fts MATCH :q"),
                {"q": query},
            )
        ]


def row_count(cid: str) -> int:
    with db.engine.connect() as connection:
        return connection.execute(
            text("SELECT count(*) FROM search_fts WHERE version_cid = :cid"), {"cid": cid}
        ).scalar_one()


def unique_word() -> str:
    """A token no other test's text contains."""
    return "w" + uuid.uuid4().hex


def paper_version_envelope() -> dict:
    """A signed ``paper.version`` envelope; its ``id`` is the version's cid."""
    key = SigningKey.generate()
    return sign_record(
        {
            "v": 1,
            "type": PAPER_VERSION_TYPE,
            "author": did_key_from_signing_key(key),
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        },
        key,
    )


# --------------------------------------------------------------------------- #
# The table
# --------------------------------------------------------------------------- #


def test_search_fts_is_an_fts5_table_with_the_spec_columns():
    assert search.ensure_table() is True

    with db.engine.connect() as connection:
        sql = connection.execute(
            text("SELECT sql FROM sqlite_master WHERE name = 'search_fts'")
        ).scalar_one()
        columns = [
            row[1] for row in connection.execute(text("PRAGMA table_info(search_fts)"))
        ]

    assert "fts5" in sql.lower()
    assert columns == ["version_cid", "title", "abstract", "body"]


def test_version_cid_is_stored_but_not_searchable():
    cid = make_version(title="Indexed words only")
    list_version(cid)
    assert search.is_indexed(cid)

    # The cid is in the row, but UNINDEXED: it is not a token anything matches.
    assert match(f'"{cid}"') == []
    assert match("indexed") == [cid]


def test_create_all_recreates_a_missing_table(monkeypatch):
    # ``create_app`` runs ``create_all``; a database that predates this plugin
    # (or lost the table) gets it back there, not only on first use.
    with db.engine.begin() as connection:
        connection.execute(text("DROP TABLE search_fts"))
    monkeypatch.setattr(search_index, "_table_engine", None)

    db.create_all()

    with db.engine.connect() as connection:
        found = connection.execute(
            text("SELECT 1 FROM sqlite_master WHERE name = 'search_fts'")
        ).first()
    assert found is not None


# --------------------------------------------------------------------------- #
# Listing a version indexes its title, abstract and text
# --------------------------------------------------------------------------- #


def test_listing_a_version_saves_its_title_abstract_and_text():
    title_word, abstract_word, body_word_1, body_word_2 = (unique_word() for _ in range(4))
    cid = make_version(
        title=f"Spectroscopy {title_word}",
        abstract=f"We measure {abstract_word} directly.",
    )
    checks.save_paragraphs(
        cid, [f"First paragraph about {body_word_1}.", f"Second one about {body_word_2}."]
    )

    list_version(cid)

    assert match(title_word) == [cid]
    assert match(abstract_word) == [cid]
    assert match(body_word_1) == [cid]
    assert match(body_word_2) == [cid]

    entry = search.get_entry(cid)
    assert entry is not None
    assert entry.version_cid == cid
    assert entry.title == f"Spectroscopy {title_word}"
    assert entry.abstract == f"We measure {abstract_word} directly."
    # Paragraphs in reading order, a blank line apart.
    assert entry.body == (
        f"First paragraph about {body_word_1}.{search.BODY_SEPARATOR}"
        f"Second one about {body_word_2}."
    )


def test_each_field_lands_in_its_own_column():
    title_word, abstract_word, body_word = (unique_word() for _ in range(3))
    cid = make_version(title=title_word, abstract=abstract_word)
    checks.save_paragraphs(cid, [body_word])

    list_version(cid)

    assert match(f"title : {title_word}") == [cid]
    assert match(f"abstract : {abstract_word}") == [cid]
    assert match(f"body : {body_word}") == [cid]
    # ... and only its own.
    assert match(f"title : {abstract_word}") == []
    assert match(f"abstract : {body_word}") == []
    assert match(f"body : {title_word}") == []


def test_a_listed_version_without_extracted_text_is_still_searchable():
    word = unique_word()
    cid = make_version(title=f"No text {word}")

    list_version(cid)

    assert match(word) == [cid]
    assert search.get_entry(cid).body == ""


def test_a_version_saved_as_already_listed_is_indexed():
    # ``save_version`` emits ``version.state_changed`` for the state it saves.
    word = unique_word()

    cid = make_version(title=word, state=LISTED)

    assert match(word) == [cid]


def test_every_listed_version_of_a_paper_is_indexed():
    paper_cid = f"paper-{uuid.uuid4().hex}"
    word_1, word_2 = unique_word(), unique_word()
    first = make_version(paper_cid=paper_cid, n=1, title=f"First {word_1}")
    second = make_version(paper_cid=paper_cid, n=2, title=f"Second {word_2}")

    list_version(first)
    list_version(second)

    assert match(word_1) == [first]
    assert match(word_2) == [second]


# --------------------------------------------------------------------------- #
# Only listed versions are searchable
# --------------------------------------------------------------------------- #


def test_a_version_is_not_indexed_before_it_is_listed():
    word = unique_word()
    cid = make_version(title=word)
    checks.save_paragraphs(cid, [f"text {word}"])
    assert match(word) == []

    transition_version(cid, SCANNING)
    assert match(word) == []

    transition_version(cid, MODERATION)
    assert match(word) == []

    transition_version(cid, LISTED)
    assert match(word) == [cid]


@pytest.mark.parametrize("stopped", [HELD, REJECTED])
def test_holding_or_rejecting_a_listed_version_removes_it(stopped):
    word = unique_word()
    cid = make_version(title=word)
    list_version(cid)
    assert match(word) == [cid]

    transition_version(cid, stopped)

    assert match(word) == []
    assert not search.is_indexed(cid)


def test_a_version_rejected_before_it_was_listed_is_never_indexed():
    word = unique_word()
    cid = make_version(title=word)

    transition_version(cid, REJECTED)

    assert match(word) == []


def test_relisting_restores_the_version_with_its_current_text():
    old_word, new_word = unique_word(), unique_word()
    cid = make_version(title=f"Relisted {unique_word()}")
    checks.save_paragraphs(cid, [f"the old text {old_word}"])
    list_version(cid)
    assert match(old_word) == [cid]

    transition_version(cid, HELD)
    checks.save_paragraphs(cid, [f"the new text {new_word}"])
    transition_version(cid, LISTED)

    assert match(new_word) == [cid]
    assert match(old_word) == []
    assert row_count(cid) == 1


def test_the_index_follows_the_database_not_the_event():
    # A notification carrying a state the database does not have must not put
    # an unlisted version into the index.
    word = unique_word()
    cid = make_version(title=word)
    paper_cid = get_version(cid).paper_cid

    emit_state_changed(
        VersionStateChanged(
            version_cid=cid, paper_cid=paper_cid, n=1, state=LISTED, previous_state=MODERATION
        )
    )

    assert get_version(cid).state == AWAITING_CONSENT
    assert match(word) == []


# --------------------------------------------------------------------------- #
# The ledger subscription
# --------------------------------------------------------------------------- #


def other_ledger_subscribers() -> int:
    """How many ``paper.version`` ledger subscribers are not the search index's.

    The ``imports`` plugin subscribes when it is imported, which happens as soon
    as anything in the process builds or imports the app, so the index cannot
    assume it is the only one.  Measured by taking the index's own out and
    putting it back.
    """
    search.uninstall()
    try:
        return ledger.subscriber_count(PAPER_VERSION_TYPE)
    finally:
        search.install()


def test_the_index_subscribes_to_paper_version_records_on_the_ledger():
    assert PAPER_VERSION_TYPE in ledger.subscribed_types()
    assert ledger.subscriber_count(PAPER_VERSION_TYPE) == other_ledger_subscribers() + 1
    assert state_changed_subscriber_count() == 1


def test_a_paper_version_record_for_a_listed_version_is_indexed_through_the_ledger():
    # Take the state-change path out so only the ledger can have done this.
    unsubscribe_version_state_changed(subscribers.on_state_changed)
    envelope = paper_version_envelope()
    word = unique_word()
    make_version(version_cid=envelope["id"], title=word, state=LISTED)
    assert match(word) == []

    ledger.append(envelope)

    assert match(word) == [envelope["id"]]


def test_a_paper_version_record_for_an_unlisted_version_is_not_indexed():
    unsubscribe_version_state_changed(subscribers.on_state_changed)
    envelope = paper_version_envelope()
    word = unique_word()
    make_version(version_cid=envelope["id"], title=word)  # awaiting_consent

    ledger.append(envelope)

    assert match(word) == []


def test_a_paper_version_record_for_a_version_this_node_does_not_hold_is_ignored():
    envelope = paper_version_envelope()

    ledger.append(envelope)

    assert not search.is_indexed(envelope["id"])


def test_other_record_types_do_not_touch_the_index():
    unsubscribe_version_state_changed(subscribers.on_state_changed)
    key = SigningKey.generate()
    other = sign_record(
        {
            "v": 1,
            "type": "paper.genesis",
            "author": did_key_from_signing_key(key),
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"nonce": uuid.uuid4().hex},
            "proofs": [],
        },
        key,
    )
    word = unique_word()
    # A listed version that happens to share the record's cid.
    make_version(version_cid=other["id"], title=word, state=LISTED)

    ledger.append(other)

    assert match(word) == []


# --------------------------------------------------------------------------- #
# Idempotence, concurrency, validation
# --------------------------------------------------------------------------- #


def test_syncing_repeatedly_leaves_one_row():
    cid = make_version(title=unique_word())
    list_version(cid)

    for _ in range(3):
        assert search.sync_version(cid) is True

    assert row_count(cid) == 1


def test_a_repeated_state_event_leaves_one_row():
    cid = make_version(title=unique_word())
    list_version(cid)
    paper_cid = get_version(cid).paper_cid

    for _ in range(2):
        emit_state_changed(
            VersionStateChanged(
                version_cid=cid, paper_cid=paper_cid, n=1, state=LISTED, previous_state=MODERATION
            )
        )

    assert row_count(cid) == 1


def test_concurrent_syncs_of_one_version_leave_one_row():
    cid = make_version(title=unique_word())
    list_version(cid)
    errors: list[BaseException] = []

    def work() -> None:
        try:
            for _ in range(5):
                search.sync_version(cid)
        except BaseException as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert row_count(cid) == 1


def test_a_hold_that_lands_while_a_listing_is_being_indexed_wins(monkeypatch):
    # Deterministic version of the race the write lock exists for.  Thread A
    # reads the version as listed and is paused before it writes; thread B then
    # holds the version, and B's notification must not slip in ahead of A's
    # write -- or A would write a row for a version that is now held.
    cid = make_version(title=unique_word())
    list_version(cid)
    search.remove_entry(cid)  # start from "listed, not yet indexed"

    read_listed = threading.Event()
    release = threading.Event()
    real_get_version = search_index.get_version

    def paused_get_version(version_cid):
        version = real_get_version(version_cid)
        if threading.current_thread() is thread_a:
            read_listed.set()
            release.wait(timeout=10)
        return version

    monkeypatch.setattr(search_index, "get_version", paused_get_version)
    thread_a = threading.Thread(target=search.sync_version, args=(cid,))
    thread_b = threading.Thread(target=transition_version, args=(cid, HELD))

    thread_a.start()
    assert read_listed.wait(timeout=10)
    thread_b.start()
    thread_b.join(timeout=0.5)  # B commits "held", then waits on A's lock
    release.set()
    thread_a.join(timeout=10)
    thread_b.join(timeout=10)

    assert get_version(cid).state == HELD
    assert row_count(cid) == 0


@pytest.mark.parametrize("final_state, expected_rows", [(LISTED, 1), (HELD, 0)])
def test_concurrent_transitions_and_syncs_settle_consistently(final_state, expected_rows):
    # A contention smoke test: one thread flips the version between listed and
    # held (each transition notifies the index) while others re-sync it.  No
    # call may fail -- SQLite "database is locked" included -- and once things
    # settle the index agrees with the database.  (The lock's ordering
    # guarantee is pinned by the deterministic test above, not by this one.)
    cid = make_version(title=unique_word())
    list_version(cid)
    errors: list[BaseException] = []

    def flip() -> None:
        try:
            for i in range(30):
                transition_version(cid, HELD if i % 2 == 0 else LISTED)
            transition_version(cid, final_state)
        except BaseException as exc:  # pragma: no cover - failure path
            errors.append(exc)

    def resync() -> None:
        try:
            for _ in range(30):
                search.sync_version(cid)
        except BaseException as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=flip)] + [
        threading.Thread(target=resync) for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert get_version(cid).state == final_state
    assert row_count(cid) == expected_rows


@pytest.mark.parametrize("bad", [None, "", 7, b"bytes"])
def test_sync_version_rejects_a_non_cid_quietly(bad):
    assert search.sync_version(bad) is False


def test_sync_version_for_an_unknown_version_indexes_nothing():
    cid = new_cid()

    assert search.sync_version(cid) is False
    assert not search.is_indexed(cid)


def test_a_text_with_fts_syntax_is_stored_literally():
    # Values are bound parameters, so quotes and operators in a title are data.
    word = unique_word()
    cid = make_version(title=f'He said "NEAR(x y)" -- {word}; DROP TABLE search_fts')

    list_version(cid)

    assert match(word) == [cid]
    assert search.get_entry(cid).title.startswith('He said "NEAR(x y)"')
    assert search.ensure_table() is True


# --------------------------------------------------------------------------- #
# The repair pass
# --------------------------------------------------------------------------- #


def test_rebuild_index_repairs_missed_notifications_and_stale_rows():
    missed_word, stale_word, orphan_word = unique_word(), unique_word(), unique_word()

    # Listed while nothing was subscribed: the notification was never heard.
    search.uninstall()
    clear_state_changed_subscribers()
    missed = make_version(title=missed_word)
    list_version(missed)
    assert match(missed_word) == []

    # A row for a version that is no longer listed, and one for a version this
    # node does not hold at all.
    held = make_version(title=stale_word)
    list_version(held)
    transition_version(held, HELD)
    search.upsert_entry(held, stale_word, "", "")
    orphan = new_cid()
    search.upsert_entry(orphan, orphan_word, "", "")

    indexed = search.rebuild_index()

    assert indexed >= 1
    assert match(missed_word) == [missed]
    assert match(stale_word) == []
    assert match(orphan_word) == []


def test_rebuild_index_is_idempotent():
    cid = make_version(title=unique_word())
    list_version(cid)

    first = search.rebuild_index()
    second = search.rebuild_index()

    assert first == second
    assert row_count(cid) == 1


# --------------------------------------------------------------------------- #
# Wiring
# --------------------------------------------------------------------------- #


def test_install_is_idempotent():
    others = other_ledger_subscribers()

    search.install()
    search.install()

    assert ledger.subscriber_count(PAPER_VERSION_TYPE) == others + 1
    assert state_changed_subscriber_count() == 1


def test_uninstall_removes_both_subscriptions():
    others = other_ledger_subscribers()

    search.uninstall()

    assert ledger.subscriber_count(PAPER_VERSION_TYPE) == others
    assert state_changed_subscriber_count() == 0


def test_the_module_loader_discovers_the_plugin_and_resubscribes_it():
    search.uninstall()
    clear_state_changed_subscribers()

    loaded = module_loader.load_modules(FastAPI())

    assert "app.modules.search" in [module.__name__ for module in loaded]
    # The search plugin (re)subscribes itself through the module loader.  Other
    # plugins (imports, notifications) may also be subscribed in this process,
    # so only require that search's subscription is present.
    assert ledger.subscriber_count(PAPER_VERSION_TYPE) >= 1
    assert state_changed_subscriber_count() >= 1

    word = unique_word()
    cid = make_version(title=word)
    list_version(cid)
    assert match(word) == [cid]


def test_the_plugin_routes_are_exposed_for_the_loader_to_mount():
    # The index itself serves nothing; the endpoints that read it (feature 87's
    # ``/v1/search/semantic``, tested in test_semantic_search.py) are exposed as
    # the package's ``router``, which the module loader mounts under ``/v1``.
    assert getattr(search, "router", None) is not None


def test_nothing_is_subscribed_or_written_on_a_database_without_fts5(monkeypatch):
    search.uninstall()
    clear_state_changed_subscribers()
    ledger.clear_subscribers()
    monkeypatch.setattr(search_index, "supported", lambda: False)
    monkeypatch.setattr(subscribers, "supported", lambda: False)

    assert search.install() is False
    assert ledger.subscriber_count(PAPER_VERSION_TYPE) == 0
    assert state_changed_subscriber_count() == 0

    cid = make_version(title=unique_word(), state=LISTED)
    assert search.sync_version(cid) is False
    assert search.get_entry(cid) is None
    assert search.rebuild_index() == 0
