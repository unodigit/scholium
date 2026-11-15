"""Tests for the ORCID uniqueness nullifier (feature 33).

Linking an ORCID iD stores ``H(issuer || orcid || domain)`` in the
``nullifiers`` table, so one iD maps to one active DID; a second link is
``409`` problem details.  Covers the hash itself (determinism, normalisation,
domain separation), the table row written by the real
``GET /v1/auth/orcid/callback`` route, the 409 contract, what "active" means
(a revoked or missing credential frees the iD, matched per iD), atomicity with
the credential row, and the race the primary key settles.
"""

from __future__ import annotations

import json
import re
import uuid

import pytest
from sqlalchemy import select

from app import db
from app.modules.orcid import (
    NULLIFIER_DOMAIN,
    ORCID_ALREADY_LINKED,
    OrcidAlreadyLinked,
    claim_nullifier,
    compute_nullifier,
    credential_nullifier,
    normalise_orcid,
    sign_state,
)
from app.modules.orcid import nullifier as nullifier_module
from app.modules.orcid import service as service_module
from app.modules.orcid.models import Credential, Nullifier, ensure_tables
from app.settings import settings

CALLBACK = "/v1/auth/orcid/callback"
PROBLEM_JSON = "application/problem+json"
ORCID = "0000-0002-1825-0097"
OTHER_ORCID = "0000-0001-5109-3700"


@pytest.fixture(autouse=True)
def mock_orcid(monkeypatch):
    monkeypatch.setattr(settings, "ORCID_MOCK", 1)


@pytest.fixture
def linker(client, node_key):
    """``link(did, orcid)``: run the callback for ``did`` and return the response."""

    def link(did: str, orcid: str = ORCID, *, code: str | None = None):
        return client.get(
            CALLBACK,
            params={"code": code or f"mock-{orcid}", "state": sign_state(did=did)},
        )

    return link


def new_did() -> str:
    return f"did:key:z6Mk{uuid.uuid4().hex}"


def nullifier_rows() -> list[tuple[str, str]]:
    ensure_tables()
    with db.SessionLocal() as session:
        return [(row.nullifier, row.did) for row in session.query(Nullifier).all()]


def credential_rows(did: str | None = None) -> list[Credential]:
    ensure_tables()
    with db.SessionLocal() as session:
        query = session.query(Credential)
        if did is not None:
            query = query.filter(Credential.did == did)
        rows = query.all()
        session.expunge_all()
        return rows


def set_status(did: str, status: str) -> None:
    with db.SessionLocal() as session:
        for row in session.query(Credential).filter(Credential.did == did):
            row.status = status
        session.commit()


def assert_conflict(response) -> dict:
    assert response.status_code == 409, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == 409, body
    assert body["title"] == "Conflict", body
    assert body["type"] == ORCID_ALREADY_LINKED, body
    assert isinstance(body["detail"], str) and body["detail"], body
    assert body["instance"] == CALLBACK, body
    assert body["errors"] and body["errors"][0]["type"] == "orcid_already_linked", body
    return body


# --------------------------------------------------------------------------- #
# The hash
# --------------------------------------------------------------------------- #


def test_nullifier_is_a_64_hex_sha256_and_deterministic():
    value = compute_nullifier("did:key:issuer", ORCID)

    assert re.fullmatch(r"[0-9a-f]{64}", value)
    assert value == compute_nullifier("did:key:issuer", ORCID)
    assert value == compute_nullifier("did:key:issuer", ORCID, NULLIFIER_DOMAIN)


def test_nullifier_changes_with_each_of_issuer_orcid_and_domain():
    base = compute_nullifier("did:key:issuer", ORCID, "orcid")

    assert compute_nullifier("did:key:other", ORCID, "orcid") != base
    assert compute_nullifier("did:key:issuer", OTHER_ORCID, "orcid") != base
    assert compute_nullifier("did:key:issuer", ORCID, "institution") != base


def test_parts_cannot_be_shifted_across_the_boundary():
    # Bare concatenation would hash these alike; length prefixes keep them apart.
    assert compute_nullifier("did:ab", "c", "orcid") != compute_nullifier("did:a", "bc", "orcid")
    assert compute_nullifier("issuer", "0000", "1") != compute_nullifier("issuer", "000", "01")


@pytest.mark.parametrize(
    "spelling",
    [
        "0000-0002-1825-009x",
        " 0000-0002-1825-009X ",
        "https://orcid.org/0000-0002-1825-009X",
        "http://sandbox.orcid.org/0000-0002-1825-009x/",
        "https://www.orcid.org/0000-0002-1825-009X",
    ],
)
def test_every_spelling_of_one_orcid_gives_one_nullifier(spelling):
    assert normalise_orcid(spelling) == "0000-0002-1825-009X"
    assert compute_nullifier("did:key:issuer", spelling) == compute_nullifier(
        "did:key:issuer", "0000-0002-1825-009X"
    )


@pytest.mark.parametrize("args", [("", ORCID), ("did:key:i", ""), ("did:key:i", "  "), ("  ", ORCID)])
def test_blank_parts_are_refused(args):
    with pytest.raises(ValueError):
        compute_nullifier(*args)
    with pytest.raises(ValueError):
        compute_nullifier("did:key:i", ORCID, "")


def test_credential_nullifier_is_read_from_the_document():
    document = {"issuer": "did:key:issuer", "credentialSubject": {"id": "did:key:s", "orcid": ORCID}}

    expected = compute_nullifier("did:key:issuer", ORCID)
    assert credential_nullifier(document) == expected
    assert credential_nullifier(json.dumps(document)) == expected
    assert credential_nullifier({**document, "issuer": {"id": "did:key:issuer"}}) == expected


@pytest.mark.parametrize(
    "document",
    [None, "not json", "[]", {}, {"issuer": "did:key:i"}, {"credentialSubject": {"orcid": ORCID}}, {"issuer": 3, "credentialSubject": {"orcid": ORCID}}],
)
def test_credential_nullifier_is_none_when_the_document_cannot_name_one(document):
    assert credential_nullifier(document) is None


# --------------------------------------------------------------------------- #
# Linking stores the nullifier
# --------------------------------------------------------------------------- #


def test_first_link_stores_the_nullifier_for_the_did(linker, node_did):
    did = new_did()

    response = linker(did)

    assert response.status_code == 200, response.text
    assert response.json()["issuer"] == node_did
    assert nullifier_rows() == [(compute_nullifier(node_did, ORCID, NULLIFIER_DOMAIN), did)]
    assert len(credential_rows(did)) == 1


def test_the_table_does_not_hold_the_plain_orcid(linker):
    linker(new_did())

    (value, _did) = nullifier_rows()[0]
    assert ORCID not in value


def test_the_nullifiers_table_has_the_specified_columns(linker):
    linker(new_did())

    columns = {c.name: c for c in Nullifier.__table__.columns}
    assert list(columns) == ["nullifier", "did"]
    assert columns["nullifier"].primary_key
    assert not columns["did"].nullable


def test_different_orcids_link_to_different_dids(linker):
    first, second = new_did(), new_did()

    assert linker(first, ORCID).status_code == 200
    assert linker(second, OTHER_ORCID).status_code == 200

    assert len(nullifier_rows()) == 2


def test_one_did_may_link_more_than_one_orcid(linker):
    did = new_did()

    assert linker(did, ORCID).status_code == 200
    assert linker(did, OTHER_ORCID).status_code == 200

    assert {holder for _n, holder in nullifier_rows()} == {did}
    assert len(nullifier_rows()) == 2


# --------------------------------------------------------------------------- #
# A second link is 409
# --------------------------------------------------------------------------- #


def test_a_second_link_of_the_same_orcid_by_another_did_is_409_problem_details(linker, node_did):
    first, second = new_did(), new_did()
    assert linker(first).status_code == 200

    body = assert_conflict(linker(second))

    assert ORCID in body["detail"]
    # The refusal must not publish who holds the iD.
    assert first not in json.dumps(body)
    # The loser got nothing, and the winner keeps the iD.
    assert credential_rows(second) == []
    assert nullifier_rows() == [(compute_nullifier(node_did, ORCID), first)]


def test_linking_the_same_orcid_to_the_same_did_again_is_409_and_adds_no_credential(linker):
    did = new_did()
    assert linker(did).status_code == 200

    assert_conflict(linker(did))

    assert len(credential_rows(did)) == 1
    assert len(nullifier_rows()) == 1


@pytest.mark.parametrize(
    "spelling",
    ["0000-0002-1825-009x", "https://orcid.org/0000-0002-1825-009X"],
)
def test_another_spelling_of_the_linked_orcid_is_409_too(linker, spelling):
    assert linker(new_did(), "0000-0002-1825-009X").status_code == 200

    assert_conflict(linker(new_did(), spelling))


def test_a_refused_link_is_never_a_500(linker):
    did = new_did()
    linker(did)

    assert linker(new_did()).status_code != 500


def test_the_409_is_consistent_for_many_repeats(linker):
    assert linker(new_did()).status_code == 200

    for _ in range(3):
        assert_conflict(linker(new_did()))

    assert len(nullifier_rows()) == 1
    assert len(credential_rows()) == 1


# --------------------------------------------------------------------------- #
# "Active": a revoked or missing credential frees the iD
# --------------------------------------------------------------------------- #


def test_a_revoked_credential_frees_the_orcid_for_another_did(linker, node_did):
    first, second = new_did(), new_did()
    assert linker(first).status_code == 200
    set_status(first, "revoked")

    assert linker(second).status_code == 200

    assert nullifier_rows() == [(compute_nullifier(node_did, ORCID), second)]
    # And now the second DID is the one that holds it.
    assert_conflict(linker(new_did()))
    assert_conflict(linker(second))


def test_a_missing_credential_frees_the_orcid(linker, node_did):
    first, second = new_did(), new_did()
    assert linker(first).status_code == 200
    with db.SessionLocal() as session:
        session.query(Credential).filter(Credential.did == first).delete()
        session.commit()

    assert linker(second).status_code == 200

    assert nullifier_rows() == [(compute_nullifier(node_did, ORCID), second)]


def test_the_same_did_can_relink_after_its_credential_was_revoked(linker):
    did = new_did()
    assert linker(did).status_code == 200
    set_status(did, "revoked")

    assert linker(did).status_code == 200

    assert len(nullifier_rows()) == 1
    assert sorted(row.status for row in credential_rows(did)) == ["revoked", "valid"]


def test_active_is_judged_per_orcid_not_per_did(linker):
    """A holder with one current credential does not keep an iD it revoked."""
    holder = new_did()
    assert linker(holder, ORCID).status_code == 200
    assert linker(holder, OTHER_ORCID).status_code == 200
    # Revoke only the credential for ORCID.
    with db.SessionLocal() as session:
        for row in session.query(Credential).filter(Credential.did == holder):
            if json.loads(row.vc)["credentialSubject"]["orcid"] == ORCID:
                row.status = "revoked"
        session.commit()

    assert linker(new_did(), ORCID).status_code == 200  # freed
    assert_conflict(linker(new_did(), OTHER_ORCID))  # still held by ``holder``


# --------------------------------------------------------------------------- #
# Atomicity and the race
# --------------------------------------------------------------------------- #


def test_no_nullifier_survives_a_failure_after_the_claim(client, node_key, monkeypatch):
    did = new_did()
    real_claim = service_module.claim_nullifier

    def claim_then_fail(*args, **kwargs):
        real_claim(*args, **kwargs)
        raise RuntimeError("credential row could not be written")

    monkeypatch.setattr(service_module, "claim_nullifier", claim_then_fail)

    with pytest.raises(RuntimeError):
        service_module.issue_orcid_credential(did, ORCID)

    monkeypatch.setattr(service_module, "claim_nullifier", real_claim)
    assert nullifier_rows() == []
    assert credential_rows() == []
    # ...so the iD is not stuck: a later link works.
    assert service_module.issue_orcid_credential(did, ORCID)["credentialSubject"]["orcid"] == ORCID


def test_losing_the_insert_race_is_the_same_409(node_key, monkeypatch):
    """Both requests read "no holder"; the primary key refuses the second insert."""
    ensure_tables()
    winner, loser = new_did(), new_did()
    value = compute_nullifier("did:key:issuer", ORCID)
    with db.SessionLocal() as session:
        session.add(Nullifier(nullifier=value, did=winner))
        session.commit()

    real_holder = nullifier_module._holder
    calls = {"n": 0}

    def stale_first_read(session, nullifier):
        calls["n"] += 1
        return None if calls["n"] == 1 else real_holder(session, nullifier)

    monkeypatch.setattr(nullifier_module, "_holder", stale_first_read)

    with db.SessionLocal() as session:
        with pytest.raises(OrcidAlreadyLinked) as raised:
            claim_nullifier(session, value, loser, orcid_id=ORCID)

    assert raised.value.status_code == 409
    assert nullifier_rows() == [(value, winner)]


def test_a_takeover_does_not_overwrite_a_concurrent_takeover(node_key, monkeypatch):
    """The takeover names the holder it saw; if that changed, it is refused."""
    ensure_tables()
    stale, racer, loser = new_did(), new_did(), new_did()
    value = compute_nullifier("did:key:issuer", ORCID)
    with db.SessionLocal() as session:
        session.add(Nullifier(nullifier=value, did=stale))  # no credential: stale
        session.commit()

    real_holder = nullifier_module._holder

    def holder_then_racer_takes_over(session, nullifier):
        seen = real_holder(session, nullifier)
        with db.SessionLocal() as other:
            other.query(Nullifier).filter(Nullifier.nullifier == nullifier).update({"did": racer})
            other.commit()
        return seen

    monkeypatch.setattr(nullifier_module, "_holder", holder_then_racer_takes_over)

    with db.SessionLocal() as session:
        with pytest.raises(OrcidAlreadyLinked):
            claim_nullifier(session, value, loser, orcid_id=ORCID)

    assert nullifier_rows() == [(value, racer)]


def test_claim_nullifier_adds_the_row_without_committing(node_key):
    ensure_tables()
    value = compute_nullifier("did:key:issuer", ORCID)
    did = new_did()

    with db.SessionLocal() as session:
        claim_nullifier(session, value, did, orcid_id=ORCID)
        assert session.execute(select(Nullifier.did)).scalar_one() == did
        session.rollback()

    assert nullifier_rows() == []


# --------------------------------------------------------------------------- #
# Existing behaviour is untouched
# --------------------------------------------------------------------------- #


def test_the_linked_credential_still_verifies_when_presented(client, linker):
    credential = linker(new_did()).json()

    response = client.post("/v1/credentials/present", json=credential)

    assert response.status_code == 200, response.text
    assert response.json() == {"verified": True}


def test_a_bad_code_is_still_400_not_409(linker):
    response = linker(new_did(), code="not-a-mock-code")

    assert response.status_code == 400
    assert nullifier_rows() == []
