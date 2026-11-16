"""Security regressions: sign-in vs key rotation, token families, nonces, cookies.

The sign-in pipeline must treat a key rotation (or a guardians recovery) as the
security event it is:

* ``/v1/auth/verify`` checks the signature against the account's *active* key
  (:func:`~app.modules.identity.resolve_active_key`), so the retired key can no
  longer sign in and the new key can.
* A ``key.rotation`` record landing in the event log revokes every refresh
  token for the rotated DID (identity subscribes to the ledger event).
* Presenting an already-retired refresh token is treated as theft: the whole
  token family for that DID is revoked, not just the replayed value.
* A sign-in nonce is consumed atomically (one UPDATE, rowcount checked), so two
  concurrent verifies cannot both succeed, and expired challenge rows are
  purged when new challenges are issued.
* The refresh token is issued in an ``HttpOnly``, ``SameSite=strict`` cookie
  scoped to ``/v1/auth/refresh`` (``Secure`` except over plain http on
  localhost), and CORS allows credentials for the configured web origins.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

from app.main import app
from app.modules import identity
from app.modules.identity import AuthChallenge, InvalidNonce
from app.modules.identity import service as identity_service

VERIFY_URL = "/v1/auth/verify"
CHALLENGE_URL = "/v1/auth/challenge"
REFRESH_URL = "/v1/auth/refresh"
LOGOUT_URL = "/v1/auth/logout"


@pytest.fixture(autouse=True)
def _identity_subscribed_to_the_ledger():
    """Make sure identity's key-rotation subscriber is registered.

    The subscriber installs when the package is imported, but other suites
    (ledger, appeals, flags, ...) call ``ledger.clear_subscribers()`` in their
    fixtures, and a registry wiped earlier in the same process would make the
    revocation tests depend on test order.  The installer is idempotent.
    """
    identity.install_key_rotation_subscriber()
    yield


@pytest.fixture
def secure_client():
    """A TestClient over https, so Secure cookies are stored and replayed."""
    with TestClient(app, base_url="https://testserver") as c:
        yield c


def _did_for(seed: SigningKey) -> str:
    return did_key_from_signing_key(seed)


def _sign_in(client, seed: SigningKey | None = None):
    """Complete a challenge-response sign-in; return ``(seed, did, body)``."""
    seed = seed or SigningKey.generate()
    did = _did_for(seed)
    nonce = client.post(CHALLENGE_URL, json={"did": did}).json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verify = client.post(
        VERIFY_URL, json={"did": did, "nonce": nonce, "signature": signature}
    )
    assert verify.status_code == 200, verify.text
    return seed, did, verify.json()


def _sign_in_attempt(client, did: str, seed: SigningKey):
    """Try to sign in as ``did`` signing with ``seed``; return the raw response.

    ``did`` and ``seed`` are independent: after a rotation the account's DID
    stays the same while the key that must sign for it moves on.
    """
    nonce = client.post(CHALLENGE_URL, json={"did": did}).json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    return client.post(
        VERIFY_URL, json={"did": did, "nonce": nonce, "signature": signature}
    )


def _rotate(did: str, new_seed: SigningKey) -> str:
    """Rotate ``did`` onto ``new_seed`` exactly like the recovery flow does."""
    from app.modules import ledger
    from app.modules.recovery.rotation import apply_rotation

    new_did = _did_for(new_seed)
    apply_rotation(did, new_did)
    ledger.append(
        {
            "v": 1,
            "type": "key.rotation",
            "author": did,
            "created": "2026-01-01T00:00:00Z",
            "prev": None,
            "body": {"oldKey": did, "newKey": new_did, "reason": "device lost"},
            "proofs": [],
        }
    )
    return new_did


# --------------------------------------------------------------------------- #
# Sign-in verifies against the active key
# --------------------------------------------------------------------------- #


def test_retired_key_cannot_sign_in_after_rotation(client):
    seed = SigningKey.generate()
    _, did, _ = _sign_in(client, seed)

    _rotate(did, SigningKey.generate())

    response = _sign_in_attempt(client, did, seed)

    assert response.status_code == 401, response.text
    assert response.headers["content-type"].startswith("application/problem+json")


def test_new_key_signs_in_after_rotation(client):
    seed = SigningKey.generate()
    _, did, _ = _sign_in(client, seed)

    new_seed = SigningKey.generate()
    _rotate(did, new_seed)

    response = _sign_in_attempt(client, did, new_seed)

    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body["access_token"], str) and body["access_token"]


def test_service_verify_signin_refuses_the_retired_key(client):
    seed = SigningKey.generate()
    _, did, _ = _sign_in(client, seed)

    _rotate(did, SigningKey.generate())

    nonce = client.post(CHALLENGE_URL, json={"did": did}).json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))

    with pytest.raises(identity_service.InvalidSignature):
        identity_service.verify_signin(did, nonce, signature)


def test_active_key_material_can_be_raw_bytes(client):
    """A rotation may record raw key material (hex), not just a did:key."""
    seed = SigningKey.generate()
    _, did, _ = _sign_in(client, seed)

    new_seed = SigningKey.generate()
    # The *public* key material (bytes(new_seed) would be the private seed).
    raw_hex = bytes(new_seed.verify_key).hex()
    from app.modules.recovery.rotation import apply_rotation

    apply_rotation(did, raw_hex)

    response = _sign_in_attempt(client, did, new_seed)
    assert response.status_code == 200, response.text

    response = _sign_in_attempt(client, did, seed)
    assert response.status_code == 401, response.text


# --------------------------------------------------------------------------- #
# Rotation revokes refresh tokens
# --------------------------------------------------------------------------- #


def test_key_rotation_revokes_outstanding_refresh_tokens(client):
    _, did, body = _sign_in(client)
    refresh_token = body["refresh_token"]

    _rotate(did, SigningKey.generate())

    response = client.post(REFRESH_URL, json={"refresh_token": refresh_token})

    assert response.status_code == 401, response.text


def test_recovery_finalization_revokes_refresh_tokens(client):
    """The recovery job's key.rotation ledger event must revoke tokens too."""
    from app.modules.recovery.finalize import finalize_recovery_request
    from app.modules.recovery.models import RecoveryRequest, ensure_requests_table
    from app import db

    _, did, body = _sign_in(client)
    refresh_token = body["refresh_token"]

    new_seed = SigningKey.generate()
    new_did = _did_for(new_seed)
    ensure_requests_table()
    past = datetime.now(timezone.utc).replace(tzinfo=None)
    with db.SessionLocal() as session:
        session.add(
            RecoveryRequest(
                id="test-recovery-revokes",
                did=did,
                new_public_key=new_did,
                approvals=[],
                status="contest",
                contest_until=past,
            )
        )
        session.commit()

    assert finalize_recovery_request("test-recovery-revokes") is True

    response = client.post(REFRESH_URL, json={"refresh_token": refresh_token})
    assert response.status_code == 401, response.text


# --------------------------------------------------------------------------- #
# Refresh-token reuse revokes the family
# --------------------------------------------------------------------------- #


def test_reused_refresh_token_revokes_the_whole_family(client):
    _, _, body = _sign_in(client)
    first = body["refresh_token"]

    rotated = client.post(REFRESH_URL, json={"refresh_token": first})
    assert rotated.status_code == 200, rotated.text
    second = rotated.json()["refresh_token"]

    # Replaying the retired token is treated as theft...
    replay = client.post(REFRESH_URL, json={"refresh_token": first})
    assert replay.status_code == 401, replay.text

    # ...so the descendant token dies with it.
    descendant = client.post(REFRESH_URL, json={"refresh_token": second})
    assert descendant.status_code == 401, descendant.text


# --------------------------------------------------------------------------- #
# Nonce atomicity and challenge purging
# --------------------------------------------------------------------------- #


def test_nonce_is_consumed_atomically(client):
    seed = SigningKey.generate()
    did = _did_for(seed)
    nonce = client.post(CHALLENGE_URL, json={"did": did}).json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))

    results: list[str] = []
    barrier = threading.Barrier(2)

    def attempt() -> None:
        try:
            barrier.wait(timeout=30)
        except threading.BrokenBarrierError:  # pragma: no cover - scheduling aid
            pass
        try:
            identity_service.verify_signin(did, nonce, signature)
            results.append("ok")
        except InvalidNonce:
            results.append("refused")

    threads = [threading.Thread(target=attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert not any(thread.is_alive() for thread in threads), "verify_signin hung"

    assert sorted(results) == ["ok", "refused"]


def test_expired_challenges_are_purged_when_new_ones_are_issued(client):
    did = _did_for(SigningKey.generate())
    stale = identity_service.issue_challenge(
        did, now=datetime(2020, 1, 1, 0, 0, 0)
    )

    from app import db

    with db.SessionLocal() as session:
        assert session.get(AuthChallenge, stale.nonce) is not None

    identity_service.issue_challenge(did)

    with db.SessionLocal() as session:
        assert session.get(AuthChallenge, stale.nonce) is None


# --------------------------------------------------------------------------- #
# The HttpOnly refresh cookie
# --------------------------------------------------------------------------- #


def _set_cookie_headers(response) -> list[dict[str, str]]:
    """Parsed ``Set-Cookie`` headers as ``{attribute: value}`` maps."""
    cookies = []
    for header in response.headers.get_list("set-cookie"):
        parts = [part.strip() for part in header.split(";")]
        attributes: dict[str, str] = {}
        attributes["value"] = parts[0]
        for part in parts[1:]:
            name, _, value = part.partition("=")
            attributes[name.lower()] = value
        cookies.append(attributes)
    return cookies


def _refresh_cookie(response) -> dict[str, str] | None:
    for cookie in _set_cookie_headers(response):
        if cookie["value"].startswith("scholium_refresh"):
            return cookie
    return None


def test_verify_issues_the_refresh_token_as_an_httponly_cookie(secure_client):
    _, _, body = _sign_in(secure_client)

    # Re-issue to inspect the headers of the verify response itself.
    seed = SigningKey.generate()
    did = _did_for(seed)
    nonce = secure_client.post(CHALLENGE_URL, json={"did": did}).json()["nonce"]
    signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
    verify = secure_client.post(
        VERIFY_URL, json={"did": did, "nonce": nonce, "signature": signature}
    )
    assert verify.status_code == 200, verify.text

    cookie = _refresh_cookie(verify)
    assert cookie is not None, verify.headers.get_list("set-cookie")
    assert cookie.get("httponly") == ""
    assert cookie.get("samesite", "").lower() == "strict"
    assert cookie.get("path") == "/v1/auth/refresh"
    assert cookie.get("secure") == "", "https origins must get a Secure cookie"
    assert cookie.get("max-age"), "the cookie lives as long as the token"


@pytest.mark.parametrize(
    "base_url", ["http://localhost", "http://127.0.0.1", "http://app.localhost"]
)
def test_refresh_cookie_is_not_secure_on_plain_http_localhost(base_url):
    # A Secure cookie would be dropped by the browser over http, breaking dev.
    with TestClient(app, base_url=base_url) as dev_client:
        seed = SigningKey.generate()
        did = _did_for(seed)
        nonce = dev_client.post(CHALLENGE_URL, json={"did": did}).json()["nonce"]
        signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
        verify = dev_client.post(
            VERIFY_URL, json={"did": did, "nonce": nonce, "signature": signature}
        )
    assert verify.status_code == 200, verify.text

    cookie = _refresh_cookie(verify)
    assert cookie is not None, verify.headers.get_list("set-cookie")
    assert "secure" not in cookie, cookie
    # Everything else about the cookie is unchanged.
    assert cookie.get("httponly") == ""
    assert cookie.get("samesite", "").lower() == "strict"
    assert cookie.get("path") == "/v1/auth/refresh"


def test_refresh_cookie_is_secure_on_plain_http_to_a_non_local_host():
    # Only loopback gets the exemption: plain http elsewhere stays Secure.
    with TestClient(app, base_url="http://scholium.example") as remote_client:
        seed = SigningKey.generate()
        did = _did_for(seed)
        nonce = remote_client.post(CHALLENGE_URL, json={"did": did}).json()["nonce"]
        signature = encode_signature(bytes(seed.sign(nonce.encode("utf-8")).signature))
        verify = remote_client.post(
            VERIFY_URL, json={"did": did, "nonce": nonce, "signature": signature}
        )
    assert verify.status_code == 200, verify.text

    cookie = _refresh_cookie(verify)
    assert cookie is not None, verify.headers.get_list("set-cookie")
    assert cookie.get("secure") == "", cookie


def test_refresh_rotates_using_only_the_cookie(secure_client):
    _, _, body = _sign_in(secure_client)

    # The browser flow: no body, the HttpOnly cookie carries the token.
    rotated = secure_client.post(REFRESH_URL)

    assert rotated.status_code == 200, rotated.text
    new_body = rotated.json()
    assert new_body["refresh_token"] != body["refresh_token"]
    cookie = _refresh_cookie(rotated)
    assert cookie is not None and cookie["value"] != f'scholium_refresh={body["refresh_token"]}'


def test_reuse_via_cookie_revokes_the_family_and_clears_the_cookie(secure_client):
    _, _, body = _sign_in(secure_client)
    first = body["refresh_token"]

    rotated = secure_client.post(REFRESH_URL)
    assert rotated.status_code == 200, rotated.text
    second = rotated.json()["refresh_token"]

    # A thief replays the stale token.  They do not hold the victim's cookie
    # jar (which now carries ``second`` and would win over anything else), so
    # the stale value is presented on its own as an explicit Cookie header.
    with TestClient(app, base_url="https://testserver") as thief:
        replay = thief.post(REFRESH_URL, headers={"Cookie": f"scholium_refresh={first}"})
    assert replay.status_code == 401, replay.text

    # The replay retired the whole family, including the legitimate holder's
    # newest token...
    dead = secure_client.post(REFRESH_URL, json={"refresh_token": second})
    assert dead.status_code == 401, dead.text
    # ...and a rejected refresh clears the cookie.
    cleared = _refresh_cookie(replay)
    assert cleared is not None and cleared.get("max-age") == "0"


def test_logout_clears_the_refresh_cookie(secure_client):
    _, _, body = _sign_in(secure_client)
    access_token = body["access_token"]

    logout = secure_client.post(LOGOUT_URL, headers={"Authorization": f"Bearer {access_token}"})

    assert logout.status_code == 204, logout.text
    cleared = _refresh_cookie(logout)
    assert cleared is not None, logout.headers.get_list("set-cookie")
    assert cleared.get("max-age") == "0"


def test_refresh_without_cookie_or_body_is_rejected(secure_client):
    response = secure_client.post(REFRESH_URL, json={})

    assert response.status_code == 422, response.text


# --------------------------------------------------------------------------- #
# CORS credentials for the web origins
# --------------------------------------------------------------------------- #


def test_cors_allows_credentials_for_configured_web_origins(client):
    response = client.options(
        "/healthz",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert response.headers.get("access-control-allow-credentials") == "true"


def test_cors_does_not_credential_unlisted_origins(client):
    response = client.options(
        "/healthz",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    # Credentials are only ever granted to a listed origin: an unlisted one
    # gets no Allow-Origin, so a browser refuses to send the cookie.  (Starlette
    # still stamps Allow-Credentials on its 400 rejection; without a matching
    # Allow-Origin that header grants nothing.)
    assert response.status_code == 400
    assert response.headers.get("access-control-allow-origin") is None


def test_cors_wildcard_origin_never_enables_credentials(monkeypatch):
    """A ``*`` in WEB_ORIGINS must not combine with credentials.

    Starlette echoes the caller's Origin back for a wildcard when credentials
    are on, which would let any site make credentialed calls.
    """
    from app.main import create_app
    from app.settings import settings

    monkeypatch.setattr(settings, "WEB_ORIGINS", "*")
    wildcard_app = create_app()

    with TestClient(wildcard_app) as wildcard_client:
        response = wildcard_client.options(
            "/healthz",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )

    assert response.headers.get("access-control-allow-credentials") is None
