"""Regressions for the refresh-token delivery and rotation contract.

Three defects motivated these tests (round 3 review):

* ``/v1/auth/verify`` and ``/v1/auth/refresh`` put the long-lived refresh
  token in the JSON body as well as in the ``HttpOnly`` cookie, so any script
  that can read a response body can steal the session.  The body must carry
  the access token and its expiry only.
* Two tabs refreshing at the same moment raced: the loser was treated as a
  thief and revoked the family, signing the user out.  A token replayed inside
  a short grace window after it was rotated must yield the same successor
  pair; replay after the window is still theft.
* The cookie was hard-wired to ``SameSite=Strict``, which only works when the
  web app and the API share a registrable domain.  It is configurable
  (default ``Lax``) and the package warns at startup when every configured web
  origin is cross-site from the API's public URL.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

from app.modules import identity
from app.modules.identity import service as identity_service
from app.security import decode_access_token

CHALLENGE_URL = "/v1/auth/challenge"
VERIFY_URL = "/v1/auth/verify"
REFRESH_URL = "/v1/auth/refresh"
COOKIE_NAME = "scholium_refresh"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _verify(client) -> tuple[str, object]:
    """Sign in a brand-new identity; return ``(did, verify response)``."""
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)

    challenge = client.post(CHALLENGE_URL, json={"did": did})
    assert challenge.status_code == 200, challenge.text
    nonce = challenge.json()["nonce"]

    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verified = client.post(
        VERIFY_URL, json={"did": did, "nonce": nonce, "signature": signature}
    )
    assert verified.status_code == 200, verified.text
    return did, verified


def _cookie_header(response) -> str | None:
    for header in response.headers.get_list("set-cookie"):
        if header.lower().startswith(f"{COOKIE_NAME.lower()}="):
            return header
    return None


def _cookie_value(response) -> str | None:
    header = _cookie_header(response)
    if header is None:
        return None
    first = header.split(";", 1)[0]
    _, _, value = first.partition("=")
    return value or None


def _cookie_attributes(response) -> dict[str, str]:
    header = _cookie_header(response)
    assert header is not None, "no scholium_refresh Set-Cookie header"
    attributes: dict[str, str] = {}
    for part in (part.strip() for part in header.split(";")):
        name, _, value = part.partition("=")
        attributes[name.lower()] = value
    return attributes


def _refresh_token(client) -> str:
    """Sign in and read the refresh token out of the Set-Cookie header.

    Python clients cannot read the body copy any more; the cookie is the
    supported delivery channel for HTTP clients too.
    """
    _, verified = _verify(client)
    token = _cookie_value(verified)
    assert token, verified.headers.get_list("set-cookie")
    return token


# --------------------------------------------------------------------------- #
# 1. The refresh token never appears in a JSON body
# --------------------------------------------------------------------------- #


def test_verify_body_carries_the_access_token_and_expiry_only(client):
    _, verified = _verify(client)
    body = verified.json()

    assert "refresh_token" not in body, "the refresh token leaked into the JSON body"
    assert isinstance(body["access_token"], str) and body["access_token"]
    assert "expires_in" in body or "expires_at" in body, body
    assert _cookie_value(verified), "the refresh token must still arrive as a cookie"


def test_refresh_body_carries_the_access_token_and_expiry_only(client):
    token = _refresh_token(client)

    refreshed = client.post(REFRESH_URL, json={"refresh_token": token})
    assert refreshed.status_code == 200, refreshed.text
    body = refreshed.json()

    assert "refresh_token" not in body, "the rotated refresh token leaked into the JSON body"
    assert isinstance(body["access_token"], str) and body["access_token"]
    assert "expires_in" in body or "expires_at" in body, body
    rotated_cookie = _cookie_value(refreshed)
    assert rotated_cookie and rotated_cookie != token


# --------------------------------------------------------------------------- #
# 2. Concurrent refresh: the loser gets the same successor pair, not a 401
# --------------------------------------------------------------------------- #


def test_concurrent_refresh_returns_the_same_successor_pair(client):
    token = _refresh_token(client)

    results: list[object] = []
    barrier = threading.Barrier(2)

    def attempt() -> None:
        try:
            barrier.wait(timeout=30)
        except threading.BrokenBarrierError:  # pragma: no cover - scheduling aid
            pass
        try:
            results.append(identity_service.refresh_access(token))
        except Exception as exc:  # recorded, asserted below
            results.append(exc)

    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert not any(thread.is_alive() for thread in threads), "refresh_access hung"

    assert len(results) == 2
    assert not any(isinstance(result, Exception) for result in results), results
    # Both racers receive the same successor *refresh* token.  Access tokens
    # are never stored, so the loser's is freshly minted rather than a replay
    # of the winner's: distinct bytes, same principal.
    (access_a, successor_a), (access_b, successor_b) = results
    assert successor_a == successor_b, "both racers must receive the same successor"
    assert decode_access_token(access_a).did == decode_access_token(access_b).did

    successor = successor_a
    # The winner's successor is a live token, not something the race revoked.
    access, _ = identity_service.refresh_access(successor)
    assert isinstance(access, str) and access


def test_parallel_http_refreshes_do_not_sign_the_user_out(client):
    """Two browser tabs presenting one cookie: both 200, one live successor."""
    from fastapi.testclient import TestClient

    from app.main import app

    token = _refresh_token(client)
    responses: list[object] = []
    barrier = threading.Barrier(2)

    def attempt() -> None:
        with TestClient(app, base_url="https://testserver") as tab:
            try:
                barrier.wait(timeout=30)
            except threading.BrokenBarrierError:  # pragma: no cover - scheduling aid
                pass
            responses.append(
                tab.post(
                    REFRESH_URL, headers={"Cookie": f"{COOKIE_NAME}={token}"}
                )
            )

    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert not any(thread.is_alive() for thread in threads)

    assert len(responses) == 2
    for response in responses:
        assert response.status_code == 200, response.text
        assert "refresh_token" not in response.json(), response.json()

    successors = {_cookie_value(response) for response in responses}
    assert len(successors) == 1 and None not in successors
    successor = successors.pop()
    assert successor != token

    # The successor both tabs received is a live token, not one the race revoked.
    follow = client.post(REFRESH_URL, json={"refresh_token": successor})
    assert follow.status_code == 200, follow.text


def test_replaying_a_just_rotated_token_returns_the_same_successor(client):
    token = _refresh_token(client)
    stale_cookie = {"Cookie": f"{COOKIE_NAME}={token}"}

    first = client.post(REFRESH_URL, headers=stale_cookie)
    assert first.status_code == 200, first.text
    second = client.post(REFRESH_URL, headers=stale_cookie)
    assert second.status_code == 200, second.text

    # Same successor refresh token, delivered again instead of a family
    # revocation.  The access token is minted afresh (none is stored to replay).
    assert _cookie_value(first) == _cookie_value(second)
    assert (
        decode_access_token(first.json()["access_token"]).did
        == decode_access_token(second.json()["access_token"]).did
    )
    assert first.json()["access_token"] != second.json()["access_token"]

    # That successor still refreshes normally.
    successor = _cookie_value(second)
    assert successor is not None
    third = client.post(REFRESH_URL, headers={"Cookie": f"{COOKIE_NAME}={successor}"})
    assert third.status_code == 200, third.text


def test_reuse_after_the_grace_window_still_revokes_the_family(client, monkeypatch):
    token = _refresh_token(client)
    stale_cookie = {"Cookie": f"{COOKIE_NAME}={token}"}

    first = client.post(REFRESH_URL, headers=stale_cookie)
    assert first.status_code == 200, first.text
    successor = _cookie_value(first)
    assert successor is not None

    # Outside the window, replay is theft again: no grace, family revoked.
    monkeypatch.setattr(identity_service, "REFRESH_REUSE_GRACE_SECONDS", 0)

    replay = client.post(REFRESH_URL, headers=stale_cookie)
    assert replay.status_code == 401, replay.text

    dead = client.post(
        REFRESH_URL, headers={"Cookie": f"{COOKIE_NAME}={successor}"}
    )
    assert dead.status_code == 401, dead.text


def test_reuse_grace_window_defaults_to_thirty_seconds():
    assert identity_service.DEFAULT_REFRESH_REUSE_GRACE_SECONDS == 30
    assert identity_service.refresh_reuse_grace_seconds() == 30


def test_reuse_grace_window_is_configurable_by_environment(monkeypatch):
    monkeypatch.setenv("REFRESH_REUSE_GRACE_SECONDS", "5")
    assert identity_service.refresh_reuse_grace_seconds() == 5


def test_reuse_grace_window_ignores_garbage_and_negative_values(monkeypatch):
    monkeypatch.setenv("REFRESH_REUSE_GRACE_SECONDS", "not-a-number")
    assert identity_service.refresh_reuse_grace_seconds() == 30
    monkeypatch.setenv("REFRESH_REUSE_GRACE_SECONDS", "-4")
    assert identity_service.refresh_reuse_grace_seconds() == 30


# --------------------------------------------------------------------------- #
# 3. The cookie: path, SameSite default and configuration
# --------------------------------------------------------------------------- #


def test_refresh_cookie_is_scoped_to_the_auth_path_tree(client):
    _, verified = _verify(client)

    attributes = _cookie_attributes(verified)
    assert attributes.get("path") == "/v1/auth"
    assert attributes.get("httponly") == ""
    assert attributes.get("samesite", "").lower() == "lax"


def test_refresh_cookie_samesite_is_configurable(client, monkeypatch):
    monkeypatch.setenv("REFRESH_COOKIE_SAMESITE", "strict")
    _, verified = _verify(client)
    assert _cookie_attributes(verified).get("samesite", "").lower() == "strict"

    monkeypatch.setenv("REFRESH_COOKIE_SAMESITE", "None")
    _, verified = _verify(client)
    assert _cookie_attributes(verified).get("samesite", "").lower() == "none"


def test_refresh_cookie_samesite_falls_back_to_lax(client, monkeypatch):
    monkeypatch.setenv("REFRESH_COOKIE_SAMESITE", "bogus")
    _, verified = _verify(client)
    assert _cookie_attributes(verified).get("samesite", "").lower() == "lax"


# --------------------------------------------------------------------------- #
# 4. Startup warning when every web origin is cross-site from the API
# --------------------------------------------------------------------------- #


def _warnings_for(records) -> list[str]:
    return [record.getMessage() for record in records if record.levelno >= logging.WARNING]


def test_startup_warns_when_every_web_origin_is_cross_site(monkeypatch, caplog):
    from app.settings import settings

    monkeypatch.setattr(settings, "WEB_ORIGINS", "https://app.example.org")
    monkeypatch.setattr(settings, "NEXT_PUBLIC_API_URL", "https://api.other.example")

    with caplog.at_level(logging.WARNING):
        identity.same_site.check_same_site_configuration()

    messages = " ".join(_warnings_for(caplog.records)).lower()
    assert "same-site" in messages or "cross-site" in messages, caplog.text


def test_startup_does_not_warn_when_a_web_origin_shares_the_api_site(monkeypatch, caplog):
    from app.settings import settings

    monkeypatch.setattr(settings, "WEB_ORIGINS", "https://app.example.org")
    monkeypatch.setattr(settings, "NEXT_PUBLIC_API_URL", "https://api.example.org")

    with caplog.at_level(logging.WARNING):
        identity.same_site.check_same_site_configuration()

    assert not _warnings_for(caplog.records), caplog.text


def test_startup_warning_is_wired_into_the_app(monkeypatch, caplog):
    """The module loader calls identity's startup hook while building the app."""
    from app.main import create_app
    from app.settings import settings

    monkeypatch.setattr(settings, "WEB_ORIGINS", "https://app.example.org")
    monkeypatch.setattr(settings, "NEXT_PUBLIC_API_URL", "https://api.other.example")

    with caplog.at_level(logging.WARNING):
        create_app()

    assert "same-site" in caplog.text.lower() or "cross-site" in caplog.text.lower()


def test_loopback_web_and_api_are_same_site():
    assert identity.same_site.is_same_site("http://localhost:3000", "http://localhost:8000")
    assert identity.same_site.is_same_site("http://127.0.0.1:3000", "http://localhost:8000")


def test_subdomains_of_one_registrable_domain_are_same_site():
    assert identity.same_site.is_same_site(
        "https://app.example.org", "https://api.example.org"
    )
    assert not identity.same_site.is_same_site(
        "https://app.example.org", "https://api.example.com"
    )


# --------------------------------------------------------------------------- #
# 5. Grace bookkeeping reaches an existing database
# --------------------------------------------------------------------------- #


def test_existing_refresh_token_table_gains_the_grace_columns():
    """``create(checkfirst=True)`` skips an existing table; upgrades must ALTER."""
    from sqlalchemy import create_engine, inspect, text

    from app.modules.identity.models import ensure_columns

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE refresh_tokens ("
                "token_hash TEXT PRIMARY KEY, did TEXT NOT NULL, "
                "expires_at DATETIME NOT NULL, "
                "rotated BOOLEAN NOT NULL DEFAULT 0)"
            )
        )

    added = ensure_columns(engine)

    columns = {column["name"] for column in inspect(engine).get_columns("refresh_tokens")}
    assert {"rotated_at", "successor_tier"} <= columns
    # No access token column is ever added: access tokens are not kept at rest.
    assert "successor_access_token" not in columns
    assert set(added) == {"rotated_at", "successor_tier"}
    # Idempotent: a second pass adds nothing.
    assert ensure_columns(engine) == []


# --------------------------------------------------------------------------- #
# 6. The grace window keeps no access token at rest
# --------------------------------------------------------------------------- #


def _stored_values(did: str) -> list[object]:
    """Every value of every column of the DID's ``refresh_tokens`` rows."""
    from sqlalchemy import text

    from app import db

    with db.engine.connect() as connection:
        rows = connection.execute(
            text("SELECT * FROM refresh_tokens WHERE did = :did"), {"did": did}
        ).all()
    return [value for row in rows for value in row]


def _assert_no_access_token_at_rest(did: str, *issued: str) -> None:
    from app.security import InvalidAccessToken

    stored = _stored_values(did)
    assert stored, "expected refresh_tokens rows for the DID"
    for value in stored:
        if not isinstance(value, str):
            continue
        assert value not in issued, "an issued access token is stored verbatim"
        try:
            decode_access_token(value)
        except InvalidAccessToken:
            continue
        raise AssertionError(f"a valid access token is stored at rest: {value[:20]}...")


def test_rotation_stores_no_access_token_in_the_database(client):
    did, verified = _verify(client)
    token = _cookie_value(verified)
    assert token

    rotated = client.post(REFRESH_URL, headers={"Cookie": f"{COOKIE_NAME}={token}"})
    assert rotated.status_code == 200, rotated.text

    _assert_no_access_token_at_rest(
        did, verified.json()["access_token"], rotated.json()["access_token"]
    )


def test_grace_replay_stores_no_access_token_in_the_database(client):
    did, verified = _verify(client)
    token = _cookie_value(verified)
    assert token
    stale_cookie = {"Cookie": f"{COOKIE_NAME}={token}"}

    first = client.post(REFRESH_URL, headers=stale_cookie)
    replay = client.post(REFRESH_URL, headers=stale_cookie)
    assert first.status_code == replay.status_code == 200, (first.text, replay.text)

    _assert_no_access_token_at_rest(
        did,
        verified.json()["access_token"],
        first.json()["access_token"],
        replay.json()["access_token"],
    )


def test_grace_replay_mints_a_fresh_access_token_for_the_same_successor(client):
    """The replay is not byte-identical: it is minted at replay time."""
    import calendar

    import jwt

    from app.security import ACCESS_TOKEN_TTL

    did, verified = _verify(client)
    token = _cookie_value(verified)
    assert token
    # Both instants are in the past so the minted tokens verify; the replay is
    # 10 s after the rotation, inside the 30 s window.
    rotated_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=20)
    replay_at = rotated_at + timedelta(seconds=10)

    first_access, successor = identity_service.refresh_access(token, now=rotated_at)
    replay_access, replay_successor = identity_service.refresh_access(
        token, now=replay_at
    )

    assert replay_successor == successor, "the same successor refresh token"
    assert replay_access != first_access, "a fresh access token, not a stored copy"
    assert decode_access_token(replay_access).did == did
    claims = jwt.decode(replay_access, options={"verify_signature": False})
    assert claims["iat"] == calendar.timegm(replay_at.utctimetuple())
    assert claims["exp"] - claims["iat"] == int(ACCESS_TOKEN_TTL.total_seconds())

    # The successor handed out twice is one live token.
    access, _ = identity_service.refresh_access(successor)
    assert decode_access_token(access).did == did


def test_grace_replay_after_a_family_revocation_is_still_refused(client):
    did, verified = _verify(client)
    token = _cookie_value(verified)
    assert token
    identity_service.refresh_access(token)

    identity_service.revoke_refresh_tokens_for_did(did)

    with pytest.raises(identity_service.InvalidRefreshToken):
        identity_service.refresh_access(token)


def test_stored_access_tokens_are_scrubbed_from_an_existing_table():
    """A database written before the fix still holds tokens; upgrades clear them."""
    from sqlalchemy import create_engine, text

    from app.modules.identity.models import ensure_columns, scrub_stored_access_tokens

    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE refresh_tokens ("
                "token_hash TEXT PRIMARY KEY, did TEXT NOT NULL, "
                "expires_at DATETIME NOT NULL, "
                "rotated BOOLEAN NOT NULL DEFAULT 0, "
                "rotated_at DATETIME, successor_access_token TEXT, "
                "successor_tier INTEGER)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO refresh_tokens "
                "(token_hash, did, expires_at, rotated, successor_access_token) "
                "VALUES ('h', 'did:key:z', '2030-01-01', 1, 'eyJ.legacy.token')"
            )
        )

    ensure_columns(engine)
    assert scrub_stored_access_tokens(engine) == 1
    assert scrub_stored_access_tokens(engine) == 0  # idempotent

    with engine.connect() as connection:
        stored = connection.execute(
            text("SELECT successor_access_token FROM refresh_tokens")
        ).scalar_one()
    assert stored is None

    # A table that never had the column is simply left alone.
    fresh = create_engine("sqlite://")
    with fresh.begin() as connection:
        connection.execute(text("CREATE TABLE refresh_tokens (token_hash TEXT PRIMARY KEY)"))
    assert scrub_stored_access_tokens(fresh) == 0
