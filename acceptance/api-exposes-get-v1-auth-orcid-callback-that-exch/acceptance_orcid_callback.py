"""Acceptance tests for: API exposes GET /v1/auth/orcid/callback (feature 32).

With ``ORCID_MOCK=1`` the callback accepts ``mock-<orcid>`` codes instead of
talking to ORCID, verifies the signed ``state`` handed back by
``/v1/auth/orcid/start``, issues a node-signed ORCID ownership verifiable
credential bound to the DID carried by that state, and saves it to the
``credentials`` table::

    GET /v1/auth/orcid/start  (with a bearer token for the DID)
        -> 200 {"state": ...}
    GET /v1/auth/orcid/callback?code=mock-0000-0002-1825-0097&state=<state>
        -> 200  (with the credential)
    GET /v1/profiles/{did}
        -> 200 {"orcid": "0000-0002-1825-0097", ...}

Only what the criteria state is asserted: the callback answers 200 (and
carries a credential, i.e. a non-empty body), and the profile afterwards
shows the linked ORCID iD.  The credential's exact field names, the
response's extra members and the problem details of any failure are left
unchecked.

Criteria (app_spec.xml, feature 32):

* With ORCID_MOCK=1, GET /v1/auth/orcid/callback?code=mock-0000-0002-1825-0097
  with a valid state returns 200 with the credential.
* GET /v1/profiles/{did} after linking shows the linked ORCID iD.
"""

from __future__ import annotations

from nacl.signing import SigningKey

from scholium_record_core import did_key_from_signing_key

from app.security import issue_access_token

#: The endpoint under test.
URL = "/v1/auth/orcid/callback"

#: The mock code the criteria pin, carrying the ORCID iD under test.
MOCK_CODE = "mock-0000-0002-1825-0097"

#: The ORCID iD embedded in ``MOCK_CODE``.
ORCID_ID = "0000-0002-1825-0097"


def start_link_flow(client) -> tuple[str, str]:
    """Start an authenticated ORCID link flow and return ``(did, state)``.

    Mints a fresh Ed25519 identity, issues an access token for it (the same
    way the API's own sign-in does) and calls ``GET /v1/auth/orcid/start``
    with that token so the resulting state carries the DID the credential
    will be bound to.  Nothing is shared between calls.
    """
    seed = SigningKey.generate()
    did = did_key_from_signing_key(seed)
    token = issue_access_token(did, 0)

    start = client.get(
        "/v1/auth/orcid/start",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert start.status_code == 200, start.text
    state = start.json()["state"]
    assert isinstance(state, str) and state, start.text
    return did, state


# --------------------------------------------------------------------------- #
# Criterion 1: mock code + valid state returns 200 with the credential
# --------------------------------------------------------------------------- #


def test_callback_with_mock_code_and_valid_state_returns_200_with_credential(
    client,
):
    _did, state = start_link_flow(client)

    response = client.get(URL, params={"code": MOCK_CODE, "state": state})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body, "the callback response must carry the issued credential"


# --------------------------------------------------------------------------- #
# Criterion 2: the profile shows the linked ORCID iD after linking
# --------------------------------------------------------------------------- #


def test_profile_shows_the_linked_orcid_id_after_linking(client):
    did, state = start_link_flow(client)

    linked = client.get(URL, params={"code": MOCK_CODE, "state": state})
    assert linked.status_code == 200, linked.text

    profile = client.get(f"/v1/profiles/{did}")
    assert profile.status_code == 200, profile.text
    assert profile.json().get("orcid") == ORCID_ID, profile.text
