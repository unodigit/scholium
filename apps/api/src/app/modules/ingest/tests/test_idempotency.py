"""Tests for the ``Idempotency-Key`` header on ``POST /v1/records`` (feature 22).

Covers persistence to the ``idempotency_keys`` table, the replay of the stored
201 (including that the handler does not run again and the ledger is not
touched), what is *not* stored (refusals), a key reused for another record,
key validation, authentication of a replay, and simultaneous retries.

Isolation matches ``test_post_records``: every test has its own author, its
own unique record bodies and its own random key, so parallel workers sharing a
database file never collide.
"""

import threading
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy.exc import OperationalError

from app import db
from app.modules import ingest
from app.modules.ingest import idempotency
from app.modules.ingest.models import IdempotencyKey

from .test_post_records import (
    URL,
    Author,
    assert_problem,
    genesis_body,
    stored,
    use_handler,
)

HEADER = "Idempotency-Key"


def new_key() -> str:
    return f"key-{uuid.uuid4().hex}"


def post(client, author, record, key=None, **extra_headers):
    headers = {**author.headers, **extra_headers}
    if key is not None:
        headers[HEADER] = key
    return client.post(URL, json=record, headers=headers)


def counting_handler(calls, state=None):
    def handler(record):
        calls.append(record["id"])
        return state

    return handler


def key_row(key):
    """The ``idempotency_keys`` row for ``key`` as ``(response, created_at)``, or ``None``."""
    with db.SessionLocal() as session:
        row = session.get(IdempotencyKey, key)
        return None if row is None else (row.response, row.created_at)


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #


def test_the_first_201_is_persisted_under_the_key(client):
    author = Author()
    record = author.record()
    key = new_key()
    assert key_row(key) is None

    with use_handler("endorsement"):
        response = post(client, author, record, key)

    assert response.status_code == 201, response.text
    row = key_row(key)
    assert row is not None
    stored_response, created_at = row
    assert stored_response == response.json()
    assert stored_response == {
        "id": record["id"],
        "shortId": None,
        "state": "accepted",
        "anchor": "pending",
    }
    assert isinstance(created_at, datetime)
    assert abs(datetime.utcnow() - created_at) < timedelta(minutes=1)


def test_a_first_response_is_not_marked_as_a_replay(client):
    author = Author()
    with use_handler("endorsement"):
        response = post(client, author, author.record(), new_key())

    assert response.status_code == 201, response.text
    assert idempotency.REPLAYED_HEADER not in response.headers


def test_a_request_without_a_key_stores_nothing(client):
    author = Author()
    record = author.record()
    with use_handler("endorsement"):
        response = post(client, author, record)

    assert response.status_code == 201, response.text
    with db.SessionLocal() as session:
        rows = session.query(IdempotencyKey).all()
    assert all(row.response.get("id") != record["id"] for row in rows)


# --------------------------------------------------------------------------- #
# Replay
# --------------------------------------------------------------------------- #


def test_a_repeated_key_replays_the_stored_201(client):
    author = Author()
    record = author.record()
    key = new_key()

    with use_handler("endorsement"):
        first = post(client, author, record, key)
        second = post(client, author, record, key)

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert second.json() == first.json()
    assert second.headers[idempotency.REPLAYED_HEADER] == "true"
    assert second.headers["content-type"].startswith("application/json")


def test_a_replay_does_not_run_the_handler_or_touch_the_ledger(client):
    author = Author()
    record = author.record()
    key = new_key()
    calls = []

    with use_handler("endorsement", counting_handler(calls)):
        assert post(client, author, record, key).status_code == 201
        before = stored(client, record["id"])
        for _ in range(3):
            assert post(client, author, record, key).status_code == 201

    assert calls == [record["id"]]
    assert stored(client, record["id"]) == before


def test_the_same_record_without_the_key_is_still_a_duplicate(client):
    """The key is what turns the 409 into a replay."""
    author = Author()
    record = author.record()
    key = new_key()

    with use_handler("endorsement"):
        assert post(client, author, record, key).status_code == 201
        without_key = post(client, author, record)

    body = assert_problem(without_key, 409)
    assert body["type"] == ingest.DUPLICATE_RECORD


def test_a_replay_returns_the_stored_state_and_short_id(client):
    author = Author()
    record = author.record("paper.genesis", genesis_body())
    key = new_key()
    states = iter(["moderation", "published"])

    def handler(record):
        return {"state": next(states)}

    with use_handler("paper.genesis", handler):
        first = post(client, author, record, key)
        second = post(client, author, record, key)

    assert first.status_code == 201, first.text
    assert first.json()["state"] == "moderation"
    assert first.json()["shortId"] is not None
    assert second.json() == first.json()


def test_a_replay_survives_a_restart(client):
    """The key lives in the database, not in process memory."""
    author = Author()
    record = author.record()
    key = new_key()

    with use_handler("endorsement"):
        first = post(client, author, record, key)

    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as restarted, use_handler("endorsement"):
        second = post(restarted, author, record, key)

    assert second.status_code == 201, second.text
    assert second.json() == first.json()
    assert second.headers[idempotency.REPLAYED_HEADER] == "true"


def test_a_relayed_copy_of_the_record_replays_too(client):
    """The caller need not be the author, so a relay retrying a record may reuse its key."""
    author = Author()
    relay = Author()
    record = author.record()
    key = new_key()

    with use_handler("endorsement"):
        first = post(client, author, record, key)
        second = post(client, relay, record, key)

    assert second.status_code == 201, second.text
    assert second.json() == first.json()


def test_different_keys_are_independent(client):
    author = Author()
    first_record = author.record()
    second_record = author.record()
    calls = []

    with use_handler("endorsement", counting_handler(calls)):
        first = post(client, author, first_record, new_key())
        second = post(client, author, second_record, new_key())

    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == first_record["id"]
    assert second.json()["id"] == second_record["id"]
    assert calls == [first_record["id"], second_record["id"]]


def test_an_unauthenticated_replay_is_refused(client):
    author = Author()
    record = author.record()
    key = new_key()

    with use_handler("endorsement"):
        assert post(client, author, record, key).status_code == 201
        anonymous = client.post(URL, json=record, headers={HEADER: key})

    assert_problem(anonymous, 401)


# --------------------------------------------------------------------------- #
# What is not stored
# --------------------------------------------------------------------------- #


def test_a_refused_submission_stores_no_key_so_the_client_can_retry(client):
    author = Author()
    record = author.record()
    broken = {**record, "id": author.record()["id"]}  # not the recomputed cid
    key = new_key()

    with use_handler("endorsement"):
        refused = post(client, author, broken, key)
        assert_problem(refused, 422)
        assert key_row(key) is None

        retried = post(client, author, record, key)

    assert retried.status_code == 201, retried.text
    assert idempotency.REPLAYED_HEADER not in retried.headers
    assert key_row(key) is not None


def test_a_handler_refusal_stores_no_key(client):
    from app.errors import ProblemException

    author = Author()
    record = author.record()
    key = new_key()

    def handler(record):
        raise ProblemException(422, "not acceptable", type="urn:test:refused")

    with use_handler("endorsement", handler):
        response = post(client, author, record, key)

    assert_problem(response, 422)
    assert key_row(key) is None
    assert stored(client, record["id"]) is None


def test_a_failure_to_store_the_key_does_not_fail_an_accepted_record(client, monkeypatch):
    author = Author()
    record = author.record()
    key = new_key()

    def broken_insert(key, response):
        raise OperationalError("INSERT", {}, Exception("disk I/O error"))

    monkeypatch.setattr(idempotency, "_insert", broken_insert)
    with use_handler("endorsement"):
        response = post(client, author, record, key)

    assert response.status_code == 201, response.text
    assert stored(client, record["id"]) is not None
    assert key_row(key) is None


# --------------------------------------------------------------------------- #
# A key belongs to one record
# --------------------------------------------------------------------------- #


def test_a_key_reused_for_a_different_record_is_refused_and_writes_nothing(client):
    author = Author()
    first_record = author.record()
    second_record = author.record()
    key = new_key()
    calls = []

    with use_handler("endorsement", counting_handler(calls)):
        first = post(client, author, first_record, key)
        reused = post(client, author, second_record, key)

        body = assert_problem(reused, 422)
        assert body["type"] == ingest.IDEMPOTENCY_KEY_REUSED
        assert body["errors"][0]["loc"] == ["header", HEADER]

        # The second record never reached the ledger, the handler or the key
        # row; the first record's key still replays.
        assert stored(client, second_record["id"]) is None
        assert calls == [first_record["id"]]
        assert key_row(key)[0] == first.json()
        assert post(client, author, first_record, key).json() == first.json()

        # ... and with a key of its own the second record goes through.
        assert post(client, author, second_record, new_key()).status_code == 201


def test_a_request_without_an_id_cannot_claim_a_stored_key(client):
    author = Author()
    record = author.record()
    key = new_key()

    with use_handler("endorsement"):
        assert post(client, author, record, key).status_code == 201
        headless = {name: value for name, value in record.items() if name != "id"}
        response = post(client, author, headless, key)

    body = assert_problem(response, 422)
    assert body["type"] == ingest.IDEMPOTENCY_KEY_REUSED


# --------------------------------------------------------------------------- #
# Key validation
# --------------------------------------------------------------------------- #


def test_a_blank_key_is_refused(client):
    author = Author()
    record = author.record()

    with use_handler("endorsement"):
        response = post(client, author, record, "   ")

    body = assert_problem(response, 422)
    assert body["type"] == ingest.INVALID_IDEMPOTENCY_KEY
    assert stored(client, record["id"]) is None


def test_an_empty_key_is_refused(client):
    author = Author()
    record = author.record()

    with use_handler("endorsement"):
        response = post(client, author, record, "")

    assert_problem(response, 422)
    assert stored(client, record["id"]) is None


def test_a_key_longer_than_the_limit_is_refused(client):
    author = Author()
    record = author.record()

    with use_handler("endorsement"):
        response = post(client, author, record, "k" * (idempotency.MAX_KEY_LENGTH + 1))

    body = assert_problem(response, 422)
    assert body["type"] == ingest.INVALID_IDEMPOTENCY_KEY
    assert stored(client, record["id"]) is None


def test_a_key_of_the_maximum_length_is_accepted(client):
    author = Author()
    key = uuid.uuid4().hex.ljust(idempotency.MAX_KEY_LENGTH, "k")
    assert len(key) == idempotency.MAX_KEY_LENGTH

    with use_handler("endorsement"):
        response = post(client, author, author.record(), key)

    assert response.status_code == 201, response.text
    assert key_row(key) is not None


def test_surrounding_whitespace_is_not_part_of_the_key():
    assert idempotency.normalise_key("  abc \t") == "abc"
    assert idempotency.normalise_key("a b") == "a b"


# --------------------------------------------------------------------------- #
# Simultaneous retries
# --------------------------------------------------------------------------- #


def test_simultaneous_requests_with_one_key_run_the_pipeline_once():
    key = new_key()
    record = {"id": "bafyreisimultaneous"}
    runs = []
    results = []

    def run():
        runs.append(1)
        time.sleep(0.1)  # long enough for the other thread to be waiting
        return {"id": record["id"], "shortId": None, "state": "accepted", "anchor": "pending"}

    def attempt():
        results.append(idempotency.execute(key, record, run))

    threads = [threading.Thread(target=attempt) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(runs) == 1
    assert len(results) == 4
    assert sorted(replayed for _, replayed in results) == [False, True, True, True]
    assert len({str(response) for response, _ in results}) == 1


def test_losing_the_cross_process_race_replays_the_winners_response():
    """Another process stored the key between our lookup and our append."""
    key = new_key()
    record = {"id": "bafyreiraced"}
    winner = {"id": record["id"], "shortId": None, "state": "accepted", "anchor": "pending"}

    def run():
        idempotency.store(key, winner)  # what the other process just did
        raise ingest.DuplicateRecord(record["id"])

    response, replayed = idempotency.execute(key, record, run)

    assert replayed is True
    assert response == winner


def test_a_duplicate_with_no_stored_key_stays_a_409():
    key = new_key()

    def run():
        raise ingest.DuplicateRecord("bafyreiunrelated")

    try:
        idempotency.execute(key, {"id": "bafyreiunrelated"}, run)
    except ingest.DuplicateRecord:
        pass
    else:  # pragma: no cover - the assertion is the point
        raise AssertionError("expected DuplicateRecord")
    assert key_row(key) is None


def test_storing_an_existing_key_keeps_the_first_response():
    key = new_key()
    first = {"id": "bafyreifirst"}

    assert idempotency.store(key, first) is True
    assert idempotency.store(key, {"id": "bafyreisecond"}) is False
    assert idempotency.lookup(key) == first
