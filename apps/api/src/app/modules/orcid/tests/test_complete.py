"""Regression tests for the ORCID login-CSRF / account-linking bug.

The flow used to finish on an *unauthenticated* ``GET /v1/auth/orcid/callback``
that trusted the DID inside the signed state.  The state is bound to the DID
that called ``/start``, not to the browser that finishes the flow, so an
attacker (A) could start a flow, hand the ``authorize_url`` to a victim (V) and
have V's ORCID iD linked to *A's* DID when V signed in at ORCID.

The fix: ORCID redirects to the web app (``/onboarding/orcid``), which POSTs
``{code, state}`` to the authenticated ``POST /v1/auth/orcid/complete``.  The
API refuses (``403``) unless the caller's DID is the state's ``did`` claim, and
only then consumes the state's ``jti`` and exchanges the code.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest

from app import db
from app.modules.orcid import (
    STATE_TTL,
    is_state_consumed,
    sign_state,
    verify_state,
)
from app.modules.orcid.models import Credential, Nullifier, ensure_tables
from app.security import UNAUTHENTICATED_TYPE, issue_access_token
from app.settings import settings

START = "/v1/auth/orcid/start"
COMPLETE = "/v1/auth/orcid/complete"
OLD_CALLBACK = "/v1/auth/orcid/callback"
PROBLEM_JSON = "application/problem+json"

ATTACKER_ORCID = "0000-0001-5109-3700"
VICTIM_ORCID = "0000-0002-1825-0097"


@pytest.fixture(autouse=True)
def mock_orcid(monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 1)


def new_did() -> str:
    return f"did:key:z6Mk{uuid.uuid4().hex}"


def bearer(did: str, tier: int = 0) -> dict[str, str]:
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def start_flow(client, did: str) -> str:
    """``did`` calls ``/start`` and gets back the signed state."""
    response = client.get(START, headers=bearer(did))
    assert response.status_code == 200, response.text
    return response.json()["state"]


def complete(client, did: str | None, *, state: str, orcid: str = VICTIM_ORCID, code: str | None = None):
    headers = bearer(did) if did is not None else {}
    return client.post(
        COMPLETE,
        json={"code": code if code is not None else f"mock-{orcid}", "state": state},
        headers=headers,
    )


def credential_rows(did: str | None = None) -> list[Credential]:
    ensure_tables()
    with db.SessionLocal() as session:
        query = session.query(Credential)
        if did is not None:
            query = query.filter(Credential.did == did)
        rows = query.all()
        session.expunge_all()
        return rows


def nullifier_count() -> int:
    ensure_tables()
    with db.SessionLocal() as session:
        return session.query(Nullifier).count()


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body["detail"], str) and body["detail"], body
    return body


# --------------------------------------------------------------------------- #
# The exploit from the report
# --------------------------------------------------------------------------- #


def test_victims_browser_cannot_link_the_victims_iD_to_the_attackers_did(client, node_key):
    """A starts the flow; V finishes it.  Nothing may be linked, anywhere."""
    attacker, victim = new_did(), new_did()
    state = start_flow(client, attacker)

    # V's browser reaches the ORCID redirect with V's own ORCID code.  Whether it
    # does so over the retired GET callback or the new POST, A's DID gets nothing.
    old = client.get(OLD_CALLBACK, params={"code": f"mock-{VICTIM_ORCID}", "state": state})
    assert old.status_code != 200, "the unauthenticated callback still links an ORCID iD"

    forged = complete(client, victim, state=state)
    assert forged.status_code == 403, forged.text

    assert credential_rows() == []
    assert nullifier_count() == 0
    assert not is_state_consumed(verify_state(state)["jti"])


def test_the_unauthenticated_get_callback_is_gone_and_touches_nothing(client, node_key):
    attacker = new_did()
    state = start_flow(client, attacker)

    response = client.get(OLD_CALLBACK, params={"code": f"mock-{VICTIM_ORCID}", "state": state})

    body = assert_problem(response, 410)
    assert "/v1/auth/orcid/complete" in body["detail"]
    assert credential_rows() == []
    assert not is_state_consumed(verify_state(state)["jti"])


# --------------------------------------------------------------------------- #
# POST /v1/auth/orcid/complete
# --------------------------------------------------------------------------- #


def test_the_owner_of_the_state_links_their_iD(client, node_key, node_did):
    did = new_did()
    state = start_flow(client, did)

    response = complete(client, did, state=state, orcid=VICTIM_ORCID)

    assert response.status_code == 200, response.text
    credential = response.json()
    assert "OrcidOwnershipCredential" in credential["type"]
    assert credential["issuer"] == node_did
    assert credential["credentialSubject"] == {"id": did, "orcid": VICTIM_ORCID}
    rows = credential_rows(did)
    assert [row.kind for row in rows] == ["orcid"]
    assert nullifier_count() == 1
    assert is_state_consumed(verify_state(state)["jti"])


def test_a_missing_token_is_401_and_leaves_the_state_unconsumed(client, node_key):
    did = new_did()
    state = start_flow(client, did)

    response = complete(client, None, state=state)

    body = assert_problem(response, 401)
    assert body["type"] == UNAUTHENTICATED_TYPE
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert credential_rows() == []
    assert not is_state_consumed(verify_state(state)["jti"])


def test_an_unusable_token_is_401(client, node_key):
    state = start_flow(client, new_did())

    response = client.post(
        COMPLETE,
        json={"code": f"mock-{VICTIM_ORCID}", "state": state},
        headers={"Authorization": "Bearer not-a-real-token"},
    )

    assert_problem(response, 401)
    assert credential_rows() == []
    assert not is_state_consumed(verify_state(state)["jti"])


def test_a_principal_mismatch_is_403_and_leaves_the_jti_unconsumed(client, node_key):
    attacker, victim = new_did(), new_did()
    state = start_flow(client, attacker)
    jti = verify_state(state)["jti"]

    response = complete(client, victim, state=state)

    body = assert_problem(response, 403)
    assert body["type"] == "urn:scholium:problem:orcid-state-principal-mismatch"
    assert body["instance"] == COMPLETE
    # The problem must not leak the DID the state is bound to.
    assert attacker not in response.text
    assert credential_rows() == []
    assert nullifier_count() == 0
    assert not is_state_consumed(jti)

    # Because the refused attempt did not burn the state, its rightful owner can
    # still finish the flow they started.
    owner = complete(client, attacker, state=state, orcid=ATTACKER_ORCID)
    assert owner.status_code == 200, owner.text
    assert owner.json()["credentialSubject"] == {"id": attacker, "orcid": ATTACKER_ORCID}


def test_the_principal_is_checked_before_the_code_is_exchanged(client, node_key):
    """A wrong caller learns nothing about the code: it is a 403, never a 400/502."""
    attacker, victim = new_did(), new_did()
    state = start_flow(client, attacker)

    response = complete(client, victim, state=state, code="not-a-valid-code")

    assert_problem(response, 403)
    assert not is_state_consumed(verify_state(state)["jti"])


def test_a_state_can_be_completed_once(client, node_key):
    did = new_did()
    state = start_flow(client, did)
    assert complete(client, did, state=state).status_code == 200

    replay = complete(client, did, state=state, orcid=ATTACKER_ORCID)

    body = assert_problem(replay, 400)
    assert "already been used" in body["detail"]
    assert len(credential_rows(did)) == 1


def test_a_state_without_a_did_cannot_be_completed(client, node_key):
    """An anonymous ``/start`` state names no one, so no one may redeem it."""
    state = sign_state()

    response = complete(client, new_did(), state=state)

    assert_problem(response, 400)
    assert credential_rows() == []


def test_an_expired_state_is_refused(client, node_key):
    did = new_did()
    long_ago = datetime.now(timezone.utc) - STATE_TTL - timedelta(minutes=1)

    response = complete(client, did, state=sign_state(did=did, now=long_ago))

    body = assert_problem(response, 400)
    assert "expired" in body["detail"]
    assert credential_rows() == []


def test_a_tampered_state_is_refused(client, node_key):
    did = new_did()
    state = start_flow(client, did)
    header, payload, signature = state.split(".")

    response = complete(client, did, state=f"{header}.{payload}.{signature[:-2]}AA")

    assert_problem(response, 400)
    assert credential_rows() == []


def test_a_bad_code_is_a_400_for_the_owner(client, node_key):
    did = new_did()
    state = start_flow(client, did)

    response = complete(client, did, state=state, code="not-a-mock-code")

    assert_problem(response, 400)
    assert credential_rows() == []


@pytest.mark.parametrize("body", [{}, {"code": "mock-x"}, {"state": "s"}, {"code": 1, "state": "s"}])
def test_the_body_must_carry_a_code_and_a_state(client, node_key, body):
    response = client.post(COMPLETE, json=body, headers=bearer(new_did()))

    assert_problem(response, 422)


def test_a_linked_iD_is_a_409_for_another_did(client, node_key):
    first, second = new_did(), new_did()
    assert complete(client, first, state=start_flow(client, first)).status_code == 200

    response = complete(client, second, state=start_flow(client, second))

    body = assert_problem(response, 409)
    assert body["type"] == "urn:scholium:problem:orcid-already-linked"
    assert body["instance"] == COMPLETE


def test_the_complete_route_is_mounted_by_the_module_loader(client):
    assert "post" in client.get("/openapi.json").json()["paths"][COMPLETE]


# --------------------------------------------------------------------------- #
# Where ORCID sends the browser back to
# --------------------------------------------------------------------------- #


def _redirect_uri(client) -> str:
    url = client.get(START, headers=bearer(new_did())).json()["authorize_url"]
    return parse_qs(urlsplit(url).query)["redirect_uri"][0]


def test_the_redirect_uri_is_the_web_onboarding_page(client, monkeypatch):
    monkeypatch.setattr(settings, "WEB_ORIGINS", "https://scholium.example.org")

    assert _redirect_uri(client) == "https://scholium.example.org/onboarding/orcid"


def test_the_first_configured_web_origin_is_the_public_one(client, monkeypatch):
    monkeypatch.setattr(settings, "WEB_ORIGINS", " https://scholium.example.org/ , https://other.example")

    assert _redirect_uri(client) == "https://scholium.example.org/onboarding/orcid"


def test_the_redirect_uri_never_points_at_the_api(client):
    assert not _redirect_uri(client).endswith("/v1/auth/orcid/callback")
    assert _redirect_uri(client).endswith("/onboarding/orcid")
