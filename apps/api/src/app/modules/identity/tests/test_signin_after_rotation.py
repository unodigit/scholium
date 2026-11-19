"""Signing in after a key rotation or a recovery reaches the original account.

A rotation (or a finalised guardians recovery) moves an account onto a new key
while the account's DID stays the same.  The web device that holds the new key
only knows that key's own ``did:key``, so before the device learned to store
the account DID it asked ``/v1/auth/challenge`` and ``/v1/auth/verify`` for the
*key's* did:key -- a DID the server had never seen -- and the server created a
new, empty tier-0 account for it.

The server therefore resolves a did:key that is the *active* key of a rotated
or recovered account to that account, for devices that do not send the account
DID.  These tests pin that behaviour, and that sign-in for an account that
never rotated, and for a device that does send the account DID, is unchanged.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, encode_signature

from app import db
from app.modules import identity
from app.modules.identity import Account, AuthChallenge, ensure_account_table
from app.modules.identity import service as identity_service
from app.security import decode_access_token

CHALLENGE_URL = "/v1/auth/challenge"
VERIFY_URL = "/v1/auth/verify"


@pytest.fixture(autouse=True)
def _identity_subscribed_to_the_ledger():
    # Other suites wipe the ledger's subscriber registry; the rotation helper
    # below appends to the ledger exactly like a real rotation does.
    identity.install_key_rotation_subscriber()
    yield


def _did(seed: SigningKey) -> str:
    return did_key_from_signing_key(seed)


def _sign_in(client, *, as_did: str, signer: SigningKey):
    """Sign in asking for ``as_did`` while signing with ``signer``.

    Returns ``(challenge_did, verify_response)``: the DID the server issued
    the challenge to, and the raw verify response.
    """
    challenge = client.post(CHALLENGE_URL, json={"did": as_did})
    assert challenge.status_code == 200, challenge.text
    body = challenge.json()
    signature = encode_signature(bytes(signer.sign(body["nonce"].encode("utf-8")).signature))
    verify = client.post(
        VERIFY_URL,
        json={"did": as_did, "nonce": body["nonce"], "signature": signature},
    )
    return body["did"], verify


def _token_claims(verify_response):
    """The principal (``did``, ``tier``) the access token carries."""
    assert verify_response.status_code == 200, verify_response.text
    return decode_access_token(verify_response.json()["access_token"])


def _set_tier(did: str, tier: int) -> None:
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        if account is None:
            account = Account(did=did, tier=tier, created_at=datetime.now(timezone.utc).replace(tzinfo=None))
            session.add(account)
        else:
            account.tier = tier
        session.commit()


def _account(did: str):
    ensure_account_table()
    with db.SessionLocal() as session:
        return session.get(Account, did)


def _rotate(did: str, new_seed: SigningKey) -> str:
    """Rotate ``did`` onto ``new_seed`` exactly like the recovery flow does."""
    from app.modules import ledger
    from app.modules.recovery.rotation import apply_rotation

    new_did = _did(new_seed)
    apply_rotation(did, new_did)
    ledger.append(
        {
            "v": 1,
            "type": "key.rotation",
            "author": did,
            "created": "2026-01-01T00:00:00Z",
            "prev": None,
            "body": {"oldKey": did, "newKey": new_did, "reason": "rotation"},
            "proofs": [],
        }
    )
    return new_did


def _account_with_tier(client, tier: int) -> tuple[SigningKey, str]:
    """A signed-in account at ``tier``; returns its genesis seed and DID."""
    seed = SigningKey.generate()
    did = _did(seed)
    challenge_did, verify = _sign_in(client, as_did=did, signer=seed)
    assert challenge_did == did
    assert verify.status_code == 200, verify.text
    _set_tier(did, tier)
    return seed, did


# --------------------------------------------------------------------------- #
# A device that only knows its key's did:key (rotated before the device stored
# the account DID) still reaches the account
# --------------------------------------------------------------------------- #


def test_signing_in_with_the_rotated_key_s_own_did_reaches_the_original_account(client):
    _, did = _account_with_tier(client, 2)
    new_seed = SigningKey.generate()
    new_did = _rotate(did, new_seed)

    challenge_did, verify = _sign_in(client, as_did=new_did, signer=new_seed)

    claims = _token_claims(verify)
    assert challenge_did == did
    assert claims.did == did
    assert claims.tier == 2
    # No account was created for the replacement key's own did:key.
    assert _account(new_did) is None


def test_the_challenge_for_the_rotated_key_is_issued_to_the_account(client):
    _, did = _account_with_tier(client, 1)
    new_seed = SigningKey.generate()
    new_did = _rotate(did, new_seed)

    response = client.post(CHALLENGE_URL, json={"did": new_did})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["did"] == did
    with db.SessionLocal() as session:
        row = session.get(AuthChallenge, body["nonce"])
        assert row is not None
        assert row.did == did


def test_verify_accepts_either_the_key_s_did_or_the_account_did_for_that_challenge(client):
    _, did = _account_with_tier(client, 3)
    new_seed = SigningKey.generate()
    new_did = _rotate(did, new_seed)

    # The device asked for the key's did:key and was told the account DID; it
    # may answer with the account DID it was given.
    challenge_did, verify = _sign_in(client, as_did=new_did, signer=new_seed)
    assert challenge_did == did
    nonce = client.post(CHALLENGE_URL, json={"did": new_did}).json()["nonce"]
    signature = encode_signature(bytes(new_seed.sign(nonce.encode("utf-8")).signature))
    answered = client.post(
        VERIFY_URL, json={"did": did, "nonce": nonce, "signature": signature}
    )

    assert _token_claims(verify).did == did
    assert _token_claims(answered).did == did
    assert _token_claims(answered).tier == 3


def test_a_recovered_account_is_reached_from_the_new_device(client):
    """Recovery finalises into ``account_keys`` the same way a rotation does."""
    _, did = _account_with_tier(client, 1)
    new_device_seed = SigningKey.generate()
    new_device_did = _rotate(did, new_device_seed)

    challenge_did, verify = _sign_in(client, as_did=new_device_did, signer=new_device_seed)

    claims = _token_claims(verify)
    assert challenge_did == did
    assert claims.did == did
    assert claims.tier == 1


def test_a_second_rotation_resolves_the_latest_key_and_not_the_retired_one(client):
    _, did = _account_with_tier(client, 2)
    middle_seed = SigningKey.generate()
    middle_did = _rotate(did, middle_seed)
    last_seed = SigningKey.generate()
    last_did = _rotate(did, last_seed)

    _, latest = _sign_in(client, as_did=last_did, signer=last_seed)
    assert _token_claims(latest).did == did

    # The middle key was retired by the second rotation: it no longer signs
    # for the account, so its own did:key is not mapped back to it.
    retired_challenge_did, retired = _sign_in(client, as_did=middle_did, signer=middle_seed)
    assert retired_challenge_did == middle_did
    assert _token_claims(retired).did == middle_did


def test_an_account_that_was_signed_into_empty_after_the_rotation_is_not_kept(client):
    """The bug's own artefact: an empty tier-0 account for the new key's did:key."""
    _, did = _account_with_tier(client, 2)
    new_seed = SigningKey.generate()
    new_did = _rotate(did, new_seed)
    _set_tier(new_did, 0)  # what signing in as the bare key left behind

    challenge_did, verify = _sign_in(client, as_did=new_did, signer=new_seed)

    claims = _token_claims(verify)
    assert challenge_did == did
    assert claims.did == did
    assert claims.tier == 2


# --------------------------------------------------------------------------- #
# What must not change
# --------------------------------------------------------------------------- #


def test_an_account_that_never_rotated_signs_in_exactly_as_before(client):
    seed = SigningKey.generate()
    did = _did(seed)

    challenge_did, first = _sign_in(client, as_did=did, signer=seed)
    _set_tier(did, 1)
    again_did, again = _sign_in(client, as_did=did, signer=seed)

    assert challenge_did == did
    assert _token_claims(first).did == did
    assert _token_claims(first).tier == 0
    assert again_did == did
    assert _token_claims(again).did == did
    assert _token_claims(again).tier == 1


def test_a_brand_new_key_still_creates_a_new_tier_0_account(client):
    seed = SigningKey.generate()
    did = _did(seed)
    assert _account(did) is None

    challenge_did, verify = _sign_in(client, as_did=did, signer=seed)

    assert challenge_did == did
    assert _token_claims(verify).did == did
    assert _token_claims(verify).tier == 0
    assert _account(did) is not None


def test_a_device_that_sends_the_account_did_signs_in_as_before(client):
    _, did = _account_with_tier(client, 2)
    new_seed = SigningKey.generate()
    _rotate(did, new_seed)

    challenge_did, verify = _sign_in(client, as_did=did, signer=new_seed)

    claims = _token_claims(verify)
    assert challenge_did == did
    assert claims.did == did
    assert claims.tier == 2


def test_the_retired_key_still_cannot_sign_in(client):
    old_seed, did = _account_with_tier(client, 2)
    _rotate(did, SigningKey.generate())

    _, verify = _sign_in(client, as_did=did, signer=old_seed)

    assert verify.status_code == 401, verify.text


def test_a_key_that_signs_for_the_account_cannot_be_used_by_someone_else(client):
    _, did = _account_with_tier(client, 2)
    new_seed = SigningKey.generate()
    new_did = _rotate(did, new_seed)

    # Resolution does not lend the account to a signature from any other key.
    challenge_did, verify = _sign_in(client, as_did=new_did, signer=SigningKey.generate())

    assert challenge_did == did
    assert verify.status_code == 401, verify.text


def test_an_account_with_a_tier_is_never_shadowed_by_another_account_s_rotation(client):
    """Naming someone's did:key as a rotation's ``newKey`` must not hijack their sign-in."""
    victim_seed, victim_did = _account_with_tier(client, 1)
    _, attacker_did = _account_with_tier(client, 0)

    # The attacker's account hands itself over to the victim's did:key.
    from app.modules.recovery.rotation import apply_rotation

    apply_rotation(attacker_did, victim_did)

    challenge_did, verify = _sign_in(client, as_did=victim_did, signer=victim_seed)

    claims = _token_claims(verify)
    assert challenge_did == victim_did
    assert claims.did == victim_did
    assert claims.tier == 1


def test_resolve_account_did_is_the_identity_for_unrelated_dids(did):
    assert identity_service.resolve_account_did(did) == did
