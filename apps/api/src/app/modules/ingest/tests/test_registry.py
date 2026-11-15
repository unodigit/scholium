"""Tests for the record-type handler registry (feature 19).

Covers: ``register(record_type, handler, min_tier)`` and its decorator form,
argument validation, duplicate handling, registration at import time from
another module, ``lookup`` of known and unknown types, and the ``422`` problem
details an unknown type produces when it escapes a route.

Isolation note: the registry is process-global and real modules register their
types into it, so every test uses its own unique record type (the ``rtype``
fixture) and removes it afterwards instead of assuming the registry is empty.
"""

import sys
import threading
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.module_loader import load_modules
from app.modules import ingest
from app.modules.ingest import (
    UNKNOWN_RECORD_TYPE,
    HandlerRegistration,
    UnknownRecordType,
    get,
    lookup,
    register,
    registered_types,
    unregister,
)
from app.security import Tier


@pytest.fixture
def rtype():
    """A record type unique to the test, unregistered again afterwards."""
    name = f"test.{uuid.uuid4().hex}"
    yield name
    unregister(name)


def handler(record):
    return "handled"


# --- register / lookup --------------------------------------------------------


def test_register_then_lookup_returns_handler_and_tier(rtype):
    returned = register(rtype, handler, 2)

    assert returned is handler
    registration = lookup(rtype)
    assert isinstance(registration, HandlerRegistration)
    assert registration.record_type == rtype
    assert registration.handler is handler
    assert registration.min_tier == 2
    assert registration.min_tier is Tier.AUTHOR


def test_min_tier_may_be_passed_by_keyword_or_as_a_tier(rtype):
    register(rtype, handler, min_tier=Tier.REVIEWER)

    assert lookup(rtype).min_tier == 3


@pytest.mark.parametrize("tier", [0, 1, 2, 3, 4])
def test_every_tier_is_accepted(rtype, tier):
    register(rtype, handler, tier)

    assert lookup(rtype).min_tier == tier


def test_register_as_decorator(rtype):
    @register(rtype, min_tier=3)
    def decorated(record):
        return "decorated"

    assert decorated(None) == "decorated"  # the function is returned unchanged
    assert lookup(rtype).handler is decorated
    assert lookup(rtype).min_tier == 3


def test_registered_types_lists_sorted_types(rtype):
    other = rtype + ".a"
    try:
        register(rtype, handler, 0)
        register(other, handler, 0)

        types = registered_types()
        assert rtype in types and other in types
        assert types == sorted(types)
    finally:
        unregister(other)


def test_unregister_removes_the_type_and_is_idempotent(rtype):
    register(rtype, handler, 1)

    unregister(rtype)
    unregister(rtype)  # no error the second time

    assert get(rtype) is None
    with pytest.raises(UnknownRecordType):
        lookup(rtype)


def test_record_types_match_exactly(rtype):
    register(rtype, handler, 1)

    assert get(rtype.upper()) is None
    assert get(rtype + " ") is None
    assert get(rtype[:-1]) is None


# --- duplicates ---------------------------------------------------------------


def test_registering_the_same_handler_and_tier_again_is_a_noop(rtype):
    register(rtype, handler, 2)
    first = lookup(rtype)

    register(rtype, handler, 2)  # what re-importing a module does

    assert lookup(rtype) is first


def test_a_different_handler_for_a_registered_type_is_refused(rtype):
    register(rtype, handler, 2)

    def other(record):
        return "other"

    with pytest.raises(ValueError, match="already registered"):
        register(rtype, other, 2)
    assert lookup(rtype).handler is handler


def test_a_different_tier_for_a_registered_type_is_refused(rtype):
    register(rtype, handler, 2)

    with pytest.raises(ValueError, match="already registered"):
        register(rtype, handler, 0)
    assert lookup(rtype).min_tier == 2


# --- validation ---------------------------------------------------------------


@pytest.mark.parametrize("bad", ["", " ", " padded", "padded ", "tab\t", None, 7, b"paper.genesis"])
def test_invalid_record_types_are_refused(bad):
    with pytest.raises(ValueError, match="record type"):
        register(bad, handler, 1)
    with pytest.raises(ValueError, match="record type"):
        register(bad, min_tier=1)  # also when used as a decorator


@pytest.mark.parametrize("bad", [-1, 5, 99, True, False, 1.0, "2", None])
def test_invalid_tiers_are_refused(rtype, bad):
    with pytest.raises(ValueError, match="min_tier"):
        register(rtype, handler, bad)
    assert get(rtype) is None


def test_min_tier_is_required(rtype):
    with pytest.raises(TypeError, match="min_tier"):
        register(rtype, handler)
    with pytest.raises(TypeError, match="min_tier"):
        register(rtype)
    assert get(rtype) is None


def test_handler_must_be_callable(rtype):
    with pytest.raises(TypeError, match="callable"):
        register(rtype, "not callable", 1)
    assert get(rtype) is None


def test_decorator_arguments_fail_where_the_decorator_is_declared(rtype):
    with pytest.raises(ValueError, match="min_tier"):
        register(rtype, min_tier=9)


# --- unknown types ------------------------------------------------------------


def test_lookup_of_an_unregistered_type_raises_unknown_record_type(rtype):
    with pytest.raises(UnknownRecordType) as caught:
        lookup(rtype)

    exc = caught.value
    assert exc.status_code == 422
    assert exc.record_type == rtype
    assert exc.type == UNKNOWN_RECORD_TYPE
    assert rtype in exc.detail


def test_unknown_record_type_is_also_a_lookup_error(rtype):
    with pytest.raises(LookupError):
        lookup(rtype)


def test_get_returns_none_for_an_unregistered_type(rtype):
    assert get(rtype) is None


@pytest.mark.parametrize("bad", [None, 3, ["paper.genesis"], {"a": 1}, b"x"])
def test_lookup_of_a_non_string_is_unknown_not_a_crash(bad):
    assert get(bad) is None
    with pytest.raises(UnknownRecordType) as caught:
        lookup(bad)
    assert caught.value.status_code == 422
    assert caught.value.errors[0]["input"] is None


def test_a_very_long_unknown_type_is_truncated_in_the_message():
    with pytest.raises(UnknownRecordType) as caught:
        lookup("x" * 5000)

    assert len(caught.value.detail) < 200
    assert len(caught.value.errors[0]["input"]) <= 64


# --- 422 problem details over HTTP ---------------------------------------------


def _probe_app() -> FastAPI:
    app = FastAPI()

    @app.get("/v1/probe/{record_type}")
    def probe(record_type: str):
        registration = lookup(record_type)
        return {"type": registration.record_type, "min_tier": int(registration.min_tier)}

    return app


def test_unknown_type_in_a_route_returns_422_problem_details(rtype):
    with TestClient(_probe_app()) as client:
        response = client.get(f"/v1/probe/{rtype}")

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["type"] == UNKNOWN_RECORD_TYPE
    assert body["title"] == "Unprocessable Content"
    assert body["status"] == 422
    assert rtype in body["detail"]
    assert body["instance"] == f"/v1/probe/{rtype}"
    assert body["errors"] == [
        {
            "loc": ["body", "type"],
            "msg": body["detail"],
            "type": "unknown_record_type",
            "input": rtype,
        }
    ]


def test_registered_type_in_a_route_is_resolved(rtype):
    register(rtype, handler, 4)

    with TestClient(_probe_app()) as client:
        response = client.get(f"/v1/probe/{rtype}")

    assert response.status_code == 200
    assert response.json() == {"type": rtype, "min_tier": 4}


# --- loading ------------------------------------------------------------------


def test_module_loader_discovers_the_ingest_package():
    loaded = load_modules(FastAPI())

    assert ingest in loaded


def test_a_module_can_register_at_import_time(tmp_path, monkeypatch):
    name = f"ingest_probe_{uuid.uuid4().hex}"
    rtype = f"probe.{uuid.uuid4().hex}"
    (tmp_path / f"{name}.py").write_text(
        "from app.modules.ingest import register\n"
        "\n"
        "def handle(record):\n"
        "    return 'probe'\n"
        "\n"
        f"register({rtype!r}, handle, 3)\n"
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    try:
        assert get(rtype) is None

        module = __import__(name)

        assert lookup(rtype).handler is module.handle
        assert lookup(rtype).min_tier == 3
    finally:
        unregister(rtype)
        sys.modules.pop(name, None)


# --- concurrency --------------------------------------------------------------


def test_concurrent_registration_of_one_type_has_a_single_winner(rtype):
    handlers = [lambda record, i=i: i for i in range(16)]
    results: list = []
    barrier = threading.Barrier(len(handlers))

    def worker(fn):
        barrier.wait()
        try:
            register(rtype, fn, 1)
            results.append("ok")
        except ValueError:
            results.append("refused")

    threads = [threading.Thread(target=worker, args=(fn,)) for fn in handlers]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results.count("ok") == 1
    assert results.count("refused") == len(handlers) - 1
    assert lookup(rtype).handler in handlers
