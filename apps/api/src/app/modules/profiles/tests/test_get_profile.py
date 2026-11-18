"""Tests for ``GET /v1/profiles/{did}`` (feature 29).

Covers: the decrypted personal fields, the trust tier, the linked ORCID iD and
the public signed reviews in one response; the pseudonymous shape for a DID
that never saved a profile; the after-erasure shape (only the DID, the tier
and the signed reviews remain); corruption being an error rather than erasure;
and the public-read auth contract (no token needed, a sent-but-bad token is a
401).

The ``credentials`` and ``review`` tables belong to plugins that have not
landed yet, so the fixtures create them in the spec's shape (from the mirrors
in :mod:`app.modules.profiles.views`) and drop them again *only when this run
created them*: when those plugins arrive, their tables are already there and
are left alone.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key
from sqlalchemy import JSON, cast, inspect, insert, text

from app import db
from app.modules import ledger
from app.modules.admin import set_tier
from app.modules.profiles import ORCID_PATTERN, public_profile, read_orcid
from app.modules.profiles import views
from app.security import UNAUTHENTICATED_TYPE

PROFILE = {
    "name": "Ada Lovelace",
    "affiliation": "Analytical Engine Co.",
    "email": "ada@example.org",
}

KNOWN_ORCID = "0000-0002-1825-0097"  # ORCID's own documented example iD


def _problem(response) -> dict:
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == response.status_code
    assert body["title"]
    return body


def _did_key() -> str:
    """A real canonical did:key, for helpers that validate their input."""
    return did_key_from_signing_key(SigningKey.generate())


def _row(did: str):
    from app.modules.profiles import ensure_tables

    ensure_tables()
    with db.engine.connect() as conn:
        return conn.execute(
            text("SELECT did, enc_blob, key_ref FROM profile WHERE did = :did"), {"did": did}
        ).one_or_none()


def _shred_key(did: str) -> None:
    """What erasure leaves behind: delete the per-object key, keep the row."""
    with db.engine.begin() as conn:
        conn.execute(
            text("DELETE FROM profile_keys WHERE key_ref = (SELECT key_ref FROM profile WHERE did = :did)"),
            {"did": did},
        )


def _drop_profile_row(did: str) -> None:
    with db.engine.begin() as conn:
        conn.execute(text("DELETE FROM profile WHERE did = :did"), {"did": did})


def _append_erasure_request(did: str) -> None:
    """Append a real ``erasure.request`` record, chain-valid, authored by ``did``."""
    ledger.append(
        {
            "v": 1,
            "type": "erasure.request",
            "author": did,
            "created": "2026-11-15T00:00:00Z",
            "prev": None,
            "body": {"basis": "data-subject-request"},
            "proofs": [],
        }
    )


def _orcid_vc(did: str, orcid: str = KNOWN_ORCID, *, uri_form: bool = False) -> dict:
    value = f"https://orcid.org/{orcid}" if uri_form else orcid
    return {
        "@context": "https://www.w3.org/ns/credentials/v2",
        "type": ["VerifiableCredential", "OrcidOwnershipCredential"],
        "issuer": "did:key:z6Mknode000000000000000000000000000000000000000",
        "issuanceDate": "2026-11-15T00:00:00Z",
        "credentialSubject": {"id": did, "orcid": value},
        "proof": {"type": "Ed25519Signature2020", "verificationMethod": "did:key:z6Mknode#0"},
    }


def _link_credential(
    did: str,
    vc: dict,
    *,
    cred_id: str | None = None,
    kind: str = "orcid",
    status: str = "valid",
) -> str:
    cred_id = cred_id or f"cred_{uuid.uuid4().hex}"
    with db.engine.begin() as conn:
        conn.execute(
            insert(views.credentials_table).values(
                id=cred_id, did=did, kind=kind, vc=json.dumps(vc), status=status
            )
        )
    return cred_id


def _scores_cell(document: dict):
    """The value to store in ``review.scores``.

    The real column is JSON. SQLite keeps whatever text it is given; PostgreSQL
    will not take JSON text bound as VARCHAR, so there it is cast to ``json``.
    """
    payload = json.dumps(document)
    if db.engine.dialect.name == "postgresql":
        return cast(payload, JSON)
    return payload


def _add_review(
    did: str | None,
    *,
    review_cid: str | None = None,
    version_cid: str = "sch:version:1",
    signed: bool = True,
    revealed: bool = True,
    revealed_at: datetime | None = None,
    committed_at: datetime | None = None,
    scores: dict | None = None,
    recommendation: str = "minor-revision",
    confidence: int = 4,
) -> str:
    review_cid = review_cid or f"sch:review:{uuid.uuid4().hex}"
    with db.engine.begin() as conn:
        conn.execute(
            insert(views.review_table).values(
                review_cid=review_cid,
                version_cid=version_cid,
                review_key=f"rk-{uuid.uuid4().hex}",
                nullifier=b"\x00" * 32,
                scores=_scores_cell(scores if scores is not None else {"soundness": 4, "evidence": 3}),
                recommendation=recommendation,
                confidence=confidence,
                report_cid=f"sch:report:{uuid.uuid4().hex}",
                signed_by=did if signed else None,
                committed_at=committed_at or datetime(2026, 11, 13, 9, 0, 0),
                revealed_at=(revealed_at or datetime(2026, 11, 14, 10, 0, 0)) if revealed else None,
            )
        )
    return review_cid


@pytest.fixture
def credentials_table():
    """The spec's ``credentials`` table, created only when it does not exist yet."""
    made = not inspect(db.engine).has_table("credentials")
    if made:
        views.credentials_table.create(bind=db.engine)
    yield
    if made:
        views.credentials_table.drop(bind=db.engine)


@pytest.fixture
def review_table():
    """The spec's ``review`` table, created only when it does not exist yet."""
    made = not inspect(db.engine).has_table("review")
    if made:
        views.review_table.create(bind=db.engine)
    yield
    if made:
        views.review_table.drop(bind=db.engine)


# --- the saved profile ------------------------------------------------------


def test_get_returns_the_decrypted_profile(client, did, auth):
    """The owner's read: the decrypted fields, including their own address."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    response = client.get(f"/v1/profiles/{did}", headers=auth(did))

    assert response.status_code == 200
    assert response.json() == {
        "did": did,
        "name": PROFILE["name"],
        "affiliation": PROFILE["affiliation"],
        "email": PROFILE["email"],
        "orcid": None,
        "tier": 0,
        "erased": False,
        "reviews": [],
    }


# --- the email is personal data ---------------------------------------------


def test_an_anonymous_get_does_not_reveal_the_email(client, did, auth):
    """A profile's email is personal data (PRD ID-7, tech_architect §12).

    The name and affiliation are the DID's public face; the address is not:
    only the owner reading their own profile may see it.
    """
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    body = client.get(f"/v1/profiles/{did}").json()

    assert body["email"] is None
    assert body["name"] == PROFILE["name"]
    assert body["affiliation"] == PROFILE["affiliation"]


def test_the_owner_sees_their_own_email(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    body = client.get(f"/v1/profiles/{did}", headers=auth(did)).json()

    assert body["email"] == PROFILE["email"]


def test_a_stranger_does_not_see_the_email(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    body = client.get(f"/v1/profiles/{did}", headers=auth(_did_key())).json()

    assert body["email"] is None
    assert body["name"] == PROFILE["name"]


def test_public_profile_only_hands_the_email_to_its_owner(client, did, auth):
    """The service layer is safe by default: no viewer, no address."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    assert public_profile(did).email is None
    assert public_profile(did, viewer_did=_did_key()).email is None
    assert public_profile(did, viewer_did=did).email == PROFILE["email"]


def test_get_reads_the_fields_out_of_the_encrypted_blob(client, did, auth):
    """The answer is decrypted, not a plaintext copy made at save time."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    row = _row(did)
    for needle in PROFILE.values():
        assert needle.encode() not in bytes(row.enc_blob)  # still encrypted at rest

    assert client.get(f"/v1/profiles/{did}").json()["name"] == PROFILE["name"]


def test_get_survives_unicode(client, did, auth):
    body = {"name": "Zoë Çelik 李雷", "affiliation": "Université de Genève", "email": "zoe@example.ch"}
    client.put(f"/v1/profiles/{did}", json=body, headers=auth(did))

    answer = client.get(f"/v1/profiles/{did}", headers=auth(did)).json()

    assert (answer["name"], answer["affiliation"], answer["email"]) == (
        body["name"], body["affiliation"], body["email"],
    )


def test_the_response_is_not_cacheable(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    assert client.get(f"/v1/profiles/{did}").headers["cache-control"] == "no-store"


def test_a_did_with_no_profile_is_only_the_pseudonymous_did(client, did):
    response = client.get(f"/v1/profiles/{did}")

    assert response.status_code == 200
    assert response.json() == {
        "did": did,
        "name": None,
        "affiliation": None,
        "email": None,
        "orcid": None,
        "tier": 0,
        "erased": False,
        "reviews": [],
    }


def test_profiles_of_different_dids_do_not_leak_into_each_other(client, did, auth):
    other = f"did:key:z6Mk{uuid.uuid4().hex}"
    client.put(f"/v1/profiles/{other}", json=PROFILE, headers=auth(other))

    assert client.get(f"/v1/profiles/{did}").json()["name"] is None


# --- tier -------------------------------------------------------------------


def test_get_shows_the_account_tier(client, did, auth):
    account = _did_key()
    client.put(f"/v1/profiles/{account}", json=PROFILE, headers=auth(account))
    set_tier(account, 3)

    assert client.get(f"/v1/profiles/{account}").json()["tier"] == 3


def test_a_wild_tier_in_the_table_is_clamped_into_range(client, did):
    with db.engine.begin() as conn:
        # created_at as text: raw binding of a datetime would use sqlite3's
        # deprecated default adapter, and this test never reads the column.
        conn.execute(
            text("INSERT INTO accounts (did, tier, created_at) VALUES (:d, 9, :at)"),
            {"d": did, "at": "2026-11-15 12:00:00"},
        )

    assert client.get(f"/v1/profiles/{did}").json()["tier"] == 4


def test_no_account_row_reads_as_tier_0(client, did):
    assert client.get(f"/v1/profiles/{did}").json()["tier"] == 0


# --- erasure ----------------------------------------------------------------


def test_after_crypto_shredding_only_the_did_remains(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    _shred_key(did)

    response = client.get(f"/v1/profiles/{did}")

    assert response.status_code == 200
    assert response.json() == {
        "did": did,
        "name": None,
        "affiliation": None,
        "email": None,
        "orcid": None,
        "tier": 0,
        "erased": True,
        "reviews": [],
    }


def test_tier_and_signed_reviews_survive_erasure(client, did, auth, review_table):
    """Erased personal data, public history: the point of crypto-shredding."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    review_cid = _add_review(did)
    _shred_key(did)

    body = client.get(f"/v1/profiles/{did}").json()

    assert body["erased"] is True
    assert body["name"] is None
    assert [review["review_cid"] for review in body["reviews"]] == [review_cid]


def test_erasure_is_seen_even_when_the_profile_row_is_gone(client, did, auth):
    """A deployment may delete the row too; the erasure record still tells."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    _append_erasure_request(did)
    _shred_key(did)
    _drop_profile_row(did)

    body = client.get(f"/v1/profiles/{did}").json()

    assert body == {
        "did": did,
        "name": None,
        "affiliation": None,
        "email": None,
        "orcid": None,
        "tier": 0,
        "erased": True,
        "reviews": [],
    }


def test_someone_elses_erasure_record_erases_nothing(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    _append_erasure_request(_did_key())  # another DID's erasure

    body = client.get(f"/v1/profiles/{did}").json()

    assert body["erased"] is False
    assert body["name"] == PROFILE["name"]


def test_saving_again_after_erasure_unerases_the_profile(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    _shred_key(did)
    updated = {**PROFILE, "name": "Ada Again"}
    client.put(f"/v1/profiles/{did}", json=updated, headers=auth(did))

    body = client.get(f"/v1/profiles/{did}").json()

    assert body["erased"] is False
    assert body["name"] == "Ada Again"


def test_an_erasure_record_alone_does_not_undo_a_resaved_profile(client, did, auth):
    """A readable profile beats the old erasure record (feature 28 resaves)."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    _shred_key(did)
    _append_erasure_request(did)
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    body = client.get(f"/v1/profiles/{did}").json()

    assert body["erased"] is False
    assert body["name"] == PROFILE["name"]


def test_a_corrupt_blob_is_an_error_not_erasure(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    blob = bytearray(bytes(_row(did).enc_blob))
    blob[-1] ^= 0x01
    with db.engine.begin() as conn:
        conn.execute(
            text("UPDATE profile SET enc_blob = :blob WHERE did = :did"),
            {"blob": bytes(blob), "did": did},
        )

    response = client.get(f"/v1/profiles/{did}")

    assert response.status_code == 500
    _problem(response)


# --- the ORCID iD -----------------------------------------------------------


def test_a_linked_orcid_is_shown(client, did, credentials_table):
    _link_credential(did, _orcid_vc(did))

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] == KNOWN_ORCID


def test_the_orcid_is_found_in_uri_form_and_returned_bare(client, did, credentials_table):
    _link_credential(did, _orcid_vc(did, uri_form=True))

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] == KNOWN_ORCID


def test_a_revoked_credential_is_not_shown(client, did, credentials_table):
    _link_credential(did, _orcid_vc(did), status="revoked")

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] is None


def test_a_suspended_credential_is_not_shown(client, did, credentials_table):
    _link_credential(did, _orcid_vc(did), status="suspended")

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] is None


def test_another_dids_credential_is_not_shown(client, did, credentials_table):
    _link_credential(_did_key(), _orcid_vc(_did_key()))

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] is None


def test_orcid_kind_rows_win_over_rows_that_sort_earlier(client, did, credentials_table):
    """Two credentials: an unrelated kind with a lower id must not win."""
    other_orcid = "0000-0001-5109-3700"
    _link_credential(did, _orcid_vc(did, other_orcid), cred_id="a-external", kind="external-id")
    _link_credential(did, _orcid_vc(did, KNOWN_ORCID), cred_id="b-orcid", kind="orcid")

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] == KNOWN_ORCID


def test_a_malformed_vc_is_skipped_not_fatal(client, did, credentials_table):
    with db.engine.begin() as conn:
        conn.execute(
            text("INSERT INTO credentials (id, did, kind, vc, status) VALUES ('bad', :did, 'orcid', '{nope', 'valid')"),
            {"did": did},
        )
    _link_credential(did, _orcid_vc(did))

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] == KNOWN_ORCID


def test_the_orcid_is_hidden_after_erasure(client, did, auth, credentials_table):
    """The credential row survives erasure; the iD must not."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))
    _link_credential(did, _orcid_vc(did))
    _shred_key(did)

    assert client.get(f"/v1/profiles/{did}").json()["orcid"] is None


def test_the_orcid_shows_for_a_did_that_never_saved_a_profile(client, did, credentials_table):
    """Linking an ORCID does not require a saved profile (feature 32's flow)."""
    _link_credential(did, _orcid_vc(did))

    body = client.get(f"/v1/profiles/{did}").json()

    assert body["orcid"] == KNOWN_ORCID
    assert body["name"] is None


@pytest.mark.parametrize(
    "text_value,expected",
    [
        ("0000-0002-1825-0097", "0000-0002-1825-0097"),
        ("https://orcid.org/0000-0002-1825-0097", "0000-0002-1825-0097"),
        ("orcid: 0000-0002-1825-009X", "0000-0002-1825-009X"),
        ("no iD here", None),
        ("12345-0000-0000-0000-0000", None),  # five groups: not an iD
        ("0000-0002-1825-00977", None),  # last group too long
        ("0000000218250097", None),  # unhyphenated
    ],
)
def test_the_orcid_pattern(text_value, expected):
    match = ORCID_PATTERN.search(text_value)
    assert (None if match is None else match.group(0)) == expected


# --- public signed reviews --------------------------------------------------


def test_signed_revealed_reviews_are_listed_oldest_first(client, did, review_table):
    first = _add_review(did, revealed_at=datetime(2026, 11, 14, 10, 0, 0))
    second = _add_review(did, revealed_at=datetime(2026, 11, 15, 8, 30, 0))

    body = client.get(f"/v1/profiles/{did}").json()

    assert [review["review_cid"] for review in body["reviews"]] == [first, second]


def test_the_review_items_carry_the_public_columns(client, did, review_table):
    review_cid = _add_review(
        did,
        version_cid="sch:version:9",
        scores={"soundness": 5, "evidence": 4, "reproducibility": 3, "novelty": 4, "clarity": 5, "limitations": 4},
        recommendation="accept",
        confidence=5,
    )

    review = client.get(f"/v1/profiles/{did}").json()["reviews"][0]

    assert review == {
        "review_cid": review_cid,
        "version_cid": "sch:version:9",
        "recommendation": "accept",
        "confidence": 5,
        "scores": {"soundness": 5, "evidence": 4, "reproducibility": 3, "novelty": 4, "clarity": 5, "limitations": 4},
        "report_cid": review["report_cid"],
        "committed_at": "2026-11-13T09:00:00",
        "revealed_at": "2026-11-14T10:00:00",
    }
    assert review["report_cid"].startswith("sch:report:")


def test_anonymous_reviews_never_appear(client, did, review_table):
    _add_review(None)  # signed_by empty: the pseudonymous case
    _add_review(None)

    assert client.get(f"/v1/profiles/{did}").json()["reviews"] == []


def test_a_signed_review_stays_private_until_revealed(client, did, review_table):
    _add_review(did, revealed=False)

    assert client.get(f"/v1/profiles/{did}").json()["reviews"] == []


def test_another_reviewers_reviews_do_not_appear(client, did, review_table):
    _add_review(_did_key())

    assert client.get(f"/v1/profiles/{did}").json()["reviews"] == []


def test_the_pseudonymity_material_never_leaves_the_table(client, did, review_table):
    secret_key = f"rk-secret-{uuid.uuid4().hex}"
    with db.engine.begin() as conn:
        conn.execute(
            insert(views.review_table).values(
                review_cid=f"sch:review:{uuid.uuid4().hex}",
                version_cid="sch:version:1",
                review_key=secret_key,
                nullifier=b"\x00" * 32,
                scores=_scores_cell({"soundness": 4}),
                recommendation="minor-revision",
                confidence=4,
                report_cid="sch:report:x",
                signed_by=did,
                committed_at=datetime(2026, 11, 13, 9, 0, 0),
                revealed_at=datetime(2026, 11, 14, 10, 0, 0),
            )
        )

    response = client.get(f"/v1/profiles/{did}")

    assert secret_key not in response.text
    for review in response.json()["reviews"]:
        assert set(review) == {
            "review_cid",
            "version_cid",
            "recommendation",
            "confidence",
            "scores",
            "report_cid",
            "committed_at",
            "revealed_at",
        }


def test_a_json_cell_the_driver_already_decoded_is_returned_as_it_is():
    """PostgreSQL's driver hands a ``json`` column over as a dict or list, not as text."""
    assert views._decode_json_cell({"soundness": 4}) == {"soundness": 4}
    assert views._decode_json_cell([1, 2]) == [1, 2]
    assert views._decode_json_cell('{"soundness": 4}') == {"soundness": 4}
    assert views._decode_json_cell("{oops") is None


def test_a_malformed_scores_cell_is_not_fatal(client, did, review_table):
    review_cid = _add_review(did)
    # What a bad cell can look like depends on the column: SQLite keeps any text
    # in a JSON column, while PostgreSQL's json type refuses text that is not
    # JSON, so there the worst it can hold is a JSON value that is no score object.
    malformed = "{oops" if db.engine.dialect.name == "sqlite" else '"oops"'
    with db.engine.begin() as conn:
        conn.execute(
            text("UPDATE review SET scores = :scores WHERE review_cid = :cid"),
            {"scores": malformed, "cid": review_cid},
        )

    review = client.get(f"/v1/profiles/{did}").json()["reviews"][0]

    assert review["review_cid"] == review_cid
    assert review["scores"] is None


# --- authentication ---------------------------------------------------------


def test_get_is_public_and_needs_no_token(client, did, auth):
    """Anyone may read the public face; only the owner sees the email."""
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    anonymous = client.get(f"/v1/profiles/{did}")
    owner = client.get(f"/v1/profiles/{did}", headers=auth(did))

    assert anonymous.status_code == owner.status_code == 200
    assert anonymous.json()["name"] == owner.json()["name"] == PROFILE["name"]
    assert anonymous.json()["email"] is None
    assert owner.json()["email"] == PROFILE["email"]


def test_a_bad_token_is_rejected_even_on_a_public_read(client, did):
    response = client.get(f"/v1/profiles/{did}", headers={"Authorization": "Bearer not-a-jwt"})

    assert response.status_code == 401
    assert _problem(response)["type"] == UNAUTHENTICATED_TYPE
    assert response.headers["www-authenticate"].startswith("Bearer")


def test_a_token_for_someone_else_reads_the_same_public_view(client, did, auth):
    client.put(f"/v1/profiles/{did}", json=PROFILE, headers=auth(did))

    stranger = client.get(f"/v1/profiles/{did}", headers=auth(_did_key()))

    assert stranger.status_code == 200
    assert stranger.json()["name"] == PROFILE["name"]
    assert stranger.json()["email"] is None


# --- the service layer ------------------------------------------------------


def test_public_profile_rejects_a_blank_did():
    with pytest.raises(ValueError):
        public_profile("  ")


def test_read_orcid_is_none_without_the_credentials_table(did):
    """The owning plugin not being loaded is "nothing linked", not an error."""
    if inspect(db.engine).has_table("credentials"):
        pytest.skip("the credentials plugin has landed; the table exists")
    assert read_orcid(did) is None
