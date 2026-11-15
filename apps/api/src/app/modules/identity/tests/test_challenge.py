"""POST /v1/auth/challenge: a single-use nonce for a did:key (feature 23)."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pytest
from multiformats import multibase
from sqlalchemy import func, inspect, select

from app import db
from app.modules import identity
from app.modules.identity import AuthChallenge

URL = "/v1/auth/challenge"
PROBLEM_JSON = "application/problem+json"

# A did:key for a secp256k1 key (from the did:key spec): valid did:key, but not
# Ed25519, so sign-in could never verify a signature for it.
SECP256K1_DID = "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _parse_z(value: str) -> datetime:
    """Parse an ISO 8601 ``...Z`` instant into a naive UTC datetime."""
    assert value.endswith("Z"), value
    return datetime.fromisoformat(value[:-1])


def _row(nonce: str) -> AuthChallenge | None:
    with db.SessionLocal() as session:
        return session.get(AuthChallenge, nonce)


def _count_for(did_value: str) -> int:
    """Rows saved for exactly ``did_value``.

    Deliberately not a count of the whole table: when this directory is run on
    its own under xdist, every worker shares one database file (see conftest),
    so a before/after table count races with other workers' inserts.  Rows for
    a *rejected* did can only come from the call under test.  Callers compare
    before and after rather than expecting zero, because that file also
    persists between runs.
    """
    with db.SessionLocal() as session:
        return session.execute(
            select(func.count()).select_from(AuthChallenge).where(AuthChallenge.did == did_value)
        ).scalar_one()


@pytest.fixture
def issue_calls(monkeypatch) -> list:
    """Record (and fail) any call the endpoint makes to ``issue_challenge``."""
    calls: list = []

    def spy(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("issue_challenge must not be reached for this request")

    monkeypatch.setattr("app.modules.identity.challenge.issue_challenge", spy)
    return calls


def _assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)
    body = response.json()
    assert body["status"] == status
    assert body["instance"] == URL
    return body


# -- success ---------------------------------------------------------------- #


def test_returns_200_with_nonce_did_and_expiry(client, did):
    before = _utcnow()
    response = client.post(URL, json={"did": did})
    after = _utcnow()

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"nonce", "did", "expires_at"}
    assert body["did"] == did
    assert isinstance(body["nonce"], str) and body["nonce"]

    expires_at = _parse_z(body["expires_at"])
    assert before + timedelta(minutes=5) <= expires_at <= after + timedelta(minutes=5)


def test_nonce_is_256_bits_of_url_safe_text(client, did):
    nonce = client.post(URL, json={"did": did}).json()["nonce"]

    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", nonce), nonce


def test_response_is_not_cacheable(client, did):
    response = client.post(URL, json={"did": did})

    assert response.headers["cache-control"] == "no-store"


def test_challenge_is_saved_unused_and_bound_to_the_did(client, did):
    body = client.post(URL, json={"did": did}).json()

    row = _row(body["nonce"])
    assert row is not None
    assert row.did == did
    assert row.used is False
    assert row.expires_at == _parse_z(body["expires_at"])


def test_each_request_issues_a_fresh_nonce_and_keeps_earlier_ones(client, did):
    first = client.post(URL, json={"did": did}).json()
    second = client.post(URL, json={"did": did}).json()

    assert first["nonce"] != second["nonce"]
    assert _row(first["nonce"]) is not None
    assert _row(second["nonce"]) is not None


def test_nonces_differ_across_dids(client, did):
    other = identity.service.did_key_from_public_key(b"\x07" * 32)

    a = client.post(URL, json={"did": did}).json()
    b = client.post(URL, json={"did": other}).json()

    assert a["nonce"] != b["nonce"]
    assert _row(a["nonce"]).did == did
    assert _row(b["nonce"]).did == other


def test_many_nonces_never_collide(client, did):
    nonces = {client.post(URL, json={"did": did}).json()["nonce"] for _ in range(25)}

    assert len(nonces) == 25


def test_unknown_body_fields_are_ignored(client, did):
    response = client.post(URL, json={"did": did, "note": "hello"})

    assert response.status_code == 200


# -- rejected input ---------------------------------------------------------- #


def _bad_dids() -> list[tuple[str, object]]:
    good = identity.service.did_key_from_public_key(b"\x09" * 32)
    short_key = "did:key:" + multibase.encode(b"\xed\x01" + b"\x00" * 31, "base58btc")
    wrong_codec = "did:key:" + multibase.encode(b"\xe7\x01" + b"\x00" * 32, "base58btc")
    base64_mb = "did:key:" + multibase.encode(b"\xed\x01" + b"\x09" * 32, "base64")
    return [
        ("empty", ""),
        ("not-a-did", "alice"),
        ("did-web", "did:web:example.com"),
        ("bare-prefix", "did:key:"),
        ("bare-multibase", "did:key:z"),
        ("garbage-base58", "did:key:z0OIl"),
        ("secp256k1", SECP256K1_DID),
        ("wrong-codec", wrong_codec),
        ("short-key", short_key),
        ("non-base58btc-multibase", base64_mb),
        ("trailing-space", good + " "),
        ("leading-space", " " + good),
        ("trailing-newline", good + "\n"),
        ("did-url-fragment", good + "#" + good[len("did:key:"):]),
        ("uppercase-scheme", "DID:KEY:" + good[len("did:key:"):]),
    ]


@pytest.mark.parametrize("label,value", _bad_dids(), ids=[label for label, _ in _bad_dids()])
def test_rejects_a_did_that_is_not_a_canonical_ed25519_did_key(client, label, value):
    before = _count_for(value)

    response = client.post(URL, json={"did": value})

    body = _assert_problem(response, 422)
    assert body["type"] == identity.INVALID_DID_TYPE
    assert "did:key" in body["detail"]
    # The rejected value is never echoed back (the message's own generic
    # example does not count), and nothing is saved for it.
    if value.strip():
        assert value not in response.text.replace("did:key:z6Mk...", "")
    assert _count_for(value) == before


@pytest.mark.parametrize(
    "payload",
    [{}, {"did": None}, {"did": 5}, {"did": ["did:key:z6Mk"]}, {"DID": "x"}],
    ids=["empty-object", "null", "number", "list", "wrong-key"],
)
def test_rejects_a_body_without_a_string_did(client, issue_calls, payload):
    response = client.post(URL, json=payload)

    body = _assert_problem(response, 422)
    assert body["errors"], "a validation problem lists what was wrong"
    # Rejected by request validation: nothing is issued, so nothing is saved.
    assert issue_calls == []


@pytest.mark.parametrize("raw", [b"", b"not json", b"[]", b'"did:key:z6Mk"'])
def test_rejects_a_body_that_is_not_a_json_object(client, issue_calls, raw):
    response = client.post(URL, content=raw, headers={"content-type": "application/json"})

    _assert_problem(response, 422)
    assert issue_calls == []


def test_only_post_is_allowed(client):
    assert client.get(URL).status_code == 405
    assert client.put(URL, json={}).status_code == 405
    assert client.delete(URL).status_code == 405


# -- persistence ------------------------------------------------------------- #


def test_table_matches_the_spec_schema():
    identity.ensure_table()
    columns = {c["name"]: c for c in inspect(db.engine).get_columns("auth_challenges")}

    assert set(columns) == {"nonce", "did", "expires_at", "used"}
    assert inspect(db.engine).get_pk_constraint("auth_challenges")["constrained_columns"] == ["nonce"]
    assert columns["did"]["nullable"] is False
    assert columns["expires_at"]["nullable"] is False
    assert columns["used"]["nullable"] is False


def test_used_defaults_to_false_at_the_database_level(client):
    # A raw INSERT that omits ``used`` (as any other writer might) is unused.
    from sqlalchemy import text

    identity.ensure_table()
    with db.SessionLocal() as session:
        session.execute(
            text(
                "INSERT INTO auth_challenges (nonce, did, expires_at) "
                "VALUES ('raw-insert-nonce', 'raw-insert-did-marker', '2030-01-01 00:00:00')"
            )
        )
        session.commit()
    try:
        assert _row("raw-insert-nonce").used is False
    finally:
        with db.SessionLocal() as session:
            session.execute(text("DELETE FROM auth_challenges WHERE nonce = 'raw-insert-nonce'"))
            session.commit()


# -- service ----------------------------------------------------------------- #


def test_ttl_is_five_minutes():
    assert identity.CHALLENGE_TTL == timedelta(minutes=5)


def test_issue_challenge_expires_exactly_five_minutes_after_the_given_instant(did):
    now = datetime(2030, 1, 2, 3, 4, 5, 678901)

    challenge = identity.issue_challenge(did, now=now)

    assert challenge.expires_at == datetime(2030, 1, 2, 3, 9, 5, 678901)
    assert _row(challenge.nonce).expires_at == challenge.expires_at


def test_issue_challenge_normalises_aware_instants_to_naive_utc(did):
    now = datetime(2030, 1, 2, 3, 4, 5, tzinfo=timezone(timedelta(hours=2)))

    challenge = identity.issue_challenge(did, now=now)

    assert challenge.expires_at == datetime(2030, 1, 2, 1, 9, 5)


def test_issue_challenge_returns_a_detached_fully_loaded_row(did):
    challenge = identity.issue_challenge(did)

    # No session is open: reading attributes must not need one.
    assert (challenge.nonce, challenge.did, challenge.used) == (challenge.nonce, did, False)
    assert isinstance(challenge.expires_at, datetime)


def test_issue_challenge_rejects_an_invalid_did_without_saving(did):
    invalid = did + "x"  # random per test, so no other worker can store it
    before = _count_for(invalid)

    with pytest.raises(identity.InvalidDid):
        identity.issue_challenge(invalid)

    assert _count_for(invalid) == before


@pytest.mark.parametrize("value", [None, 5, b"did:key:z6Mk", ["x"]])
def test_validate_did_rejects_non_strings(value):
    with pytest.raises(identity.InvalidDid):
        identity.validate_did(value)


def test_validate_did_returns_a_valid_did_unchanged(did):
    assert identity.validate_did(did) == did


def test_validate_did_rejects_a_spelling_a_lenient_decoder_would_accept(did, monkeypatch):
    # record-core's decoder refuses every non-canonical spelling today, so the
    # round-trip backstop is unreachable with real input.  Simulate a decoder
    # that trims whitespace to prove the backstop still holds the line.
    from scholium_record_core import public_key_from_did_key

    monkeypatch.setattr(
        identity.service,
        "public_key_from_did_key",
        lambda value: public_key_from_did_key(value.strip()),
    )

    assert identity.validate_did(did) == did
    with pytest.raises(identity.InvalidDid, match="canonical"):
        identity.validate_did(did + " ")


def test_module_router_serves_the_endpoint_under_the_v1_prefix(client):
    paths = client.get("/openapi.json").json()["paths"]

    assert set(paths[URL]) == {"post"}
