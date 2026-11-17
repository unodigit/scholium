"""Regression tests: duplicate endorsements and the public endorsement list.

Bug: after endorsing a newcomer, the same reviewer could endorse the same
person in the same category again (every extra record was accepted), and a
profile had no way to read back the endorsements its person holds.

* ``POST /v1/records`` refuses an ``endorsement`` whose (endorser, endorsee,
  category) already has an *active* endorsement with ``409`` problem details.
  A different category, endorser or endorsee is a different fact, and an
  endorsement that has lapsed no longer stands in the way of a fresh one.
* ``GET /v1/profiles/{did}/endorsements`` is the public read of what a DID
  holds: category, endorser (DID plus the name the endorser made public) and
  the date the node accepted it.  It needs no token and leaves out lapsed
  endorsements.

Isolation: every test uses fresh DIDs and a unique record body, as in
``test_endorsements``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from urllib.parse import quote

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db
from app.modules import ledger
from app.modules.endorsements import ENDORSEMENT_TYPE, Endorsement, save_endorsement
from app.modules.identity.models import Account, ensure_account_table
from app.modules.profiles import ProfileData, erase_profile, save_profile
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _new_did() -> str:
    return did_key_from_signing_key(SigningKey.generate())


#: The categories a test reviewer is endorsed in: an endorser may only endorse
#: in a category they are themself endorsed in (see ``test_endorser_category``).
STANDING = ("cs.AI", "cs.LG", "cs.CL")


class Reviewer:
    """A tier-3 account that signs and posts endorsement records."""

    def __init__(self, name: str | None = None, standing: tuple[str, ...] = STANDING) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 3)}"}
        ensure_account_table()
        with db.SessionLocal() as session:
            session.add(Account(did=self.did, tier=3, created_at=_utcnow()))
            session.commit()
        for category in standing:
            save_endorsement(
                record_cid=f"cid-{uuid.uuid4().hex}",
                endorser_did=_new_did(),
                endorsee_did=self.did,
                category=category,
            )
        if name is not None:
            save_profile(
                self.did,
                ProfileData(name=name, affiliation="Test Lab", email="reviewer@example.org"),
            )

    def endorse(self, client, endorsee: str, category: str = "cs.AI", **body):
        """Sign and post one endorsement; each call is a distinct record."""
        record = sign_record(
            {
                "v": 1,
                "type": ENDORSEMENT_TYPE,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": None,
                "body": {
                    "endorsee": endorsee,
                    "category": category,
                    "statement": f"test {uuid.uuid4().hex}",
                    **body,
                },
                "proofs": [],
            },
            self.seed,
        )
        return record, client.post(URL, json=record, headers=self.headers)


def _rows(endorser: str, endorsee: str, category: str) -> list[Endorsement]:
    with db.SessionLocal() as session:
        return (
            session.query(Endorsement)
            .filter_by(endorser_did=endorser, endorsee_did=endorsee, category=category)
            .all()
        )


def _listing(client, did: str):
    return client.get(f"/v1/profiles/{quote(did, safe='')}/endorsements")


# --------------------------------------------------------------------------- #
# Duplicates: 409
# --------------------------------------------------------------------------- #


def test_endorsing_the_same_person_in_the_same_category_twice_is_a_409(client):
    reviewer = Reviewer()
    newcomer = _new_did()

    _, first = reviewer.endorse(client, newcomer, "cs.AI")
    assert first.status_code == 201, first.text

    second_record, second = reviewer.endorse(client, newcomer, "cs.AI")

    assert second.status_code == 409, second.text
    assert second.headers["content-type"].startswith(PROBLEM_JSON)
    problem = second.json()
    assert problem["status"] == 409
    assert "cs.AI" in problem["detail"]
    assert "already" in problem["detail"].lower()

    # Refused before the ledger append: one row, and the refused record is not stored.
    assert len(_rows(reviewer.did, newcomer, "cs.AI")) == 1
    assert ledger.entry_by_cid(second_record["id"]) is None


def test_the_duplicate_check_is_per_endorser_endorsee_and_category(client):
    reviewer = Reviewer()
    other_reviewer = Reviewer()
    newcomer = _new_did()
    someone_else = _new_did()

    _, first = reviewer.endorse(client, newcomer, "cs.AI")
    assert first.status_code == 201, first.text

    # Another category, another endorser and another endorsee are other facts.
    assert reviewer.endorse(client, newcomer, "cs.LG")[1].status_code == 201
    assert other_reviewer.endorse(client, newcomer, "cs.AI")[1].status_code == 201
    assert reviewer.endorse(client, someone_else, "cs.AI")[1].status_code == 201


def test_a_lapsed_endorsement_does_not_block_a_fresh_one(client):
    reviewer = Reviewer()
    newcomer = _new_did()

    _, lapsed = reviewer.endorse(client, newcomer, "cs.AI", expiry="2020-01-01T00:00:00Z")
    assert lapsed.status_code == 201, lapsed.text

    _, renewed = reviewer.endorse(client, newcomer, "cs.AI")
    assert renewed.status_code == 201, renewed.text


# --------------------------------------------------------------------------- #
# GET /v1/profiles/{did}/endorsements
# --------------------------------------------------------------------------- #


def test_the_listing_names_category_endorser_and_date_without_a_token(client):
    reviewer = Reviewer(name="Tunde Okafor")
    newcomer = _new_did()
    record, posted = reviewer.endorse(client, newcomer, "cs.AI")
    assert posted.status_code == 201, posted.text

    response = _listing(client, newcomer)  # no Authorization header

    assert response.status_code == 200, response.text
    rows = response.json()
    assert len(rows) == 1
    row = rows[0]
    assert row["record_cid"] == record["id"]
    assert row["endorser_did"] == reviewer.did
    assert row["endorser_name"] == "Tunde Okafor"
    assert row["endorsee_did"] == newcomer
    assert row["category"] == "cs.AI"
    assert row["expires_at"] is None
    # The date the node accepted the endorsement: an ISO 8601 UTC instant.
    accepted = datetime.fromisoformat(row["endorsed_at"].replace("Z", "+00:00"))
    assert abs((datetime.now(timezone.utc) - accepted).total_seconds()) < 300


def test_an_endorser_with_no_public_name_is_listed_by_did_alone(client):
    reviewer = Reviewer()  # never saved a profile
    newcomer = _new_did()
    assert reviewer.endorse(client, newcomer)[1].status_code == 201

    (row,) = _listing(client, newcomer).json()

    assert row["endorser_did"] == reviewer.did
    assert row["endorser_name"] is None


def test_an_erased_endorsers_name_is_not_listed(client):
    reviewer = Reviewer(name="Tunde Okafor")
    newcomer = _new_did()
    assert reviewer.endorse(client, newcomer)[1].status_code == 201
    erase_profile(reviewer.did)

    (row,) = _listing(client, newcomer).json()

    assert row["endorser_did"] == reviewer.did
    assert row["endorser_name"] is None


def test_the_listing_is_ordered_by_category_and_leaves_out_lapsed_endorsements(client):
    reviewer = Reviewer()
    newcomer = _new_did()
    assert reviewer.endorse(client, newcomer, "cs.LG")[1].status_code == 201
    assert reviewer.endorse(client, newcomer, "cs.AI")[1].status_code == 201
    assert reviewer.endorse(client, newcomer, "cs.CL", expiry="2020-01-01T00:00:00Z")[1].status_code == 201

    rows = _listing(client, newcomer).json()

    assert [row["category"] for row in rows] == ["cs.AI", "cs.LG"]


def test_only_the_endorsements_a_did_holds_are_listed(client):
    reviewer = Reviewer()
    newcomer = _new_did()
    someone_else = _new_did()
    assert reviewer.endorse(client, newcomer, "cs.AI")[1].status_code == 201
    assert reviewer.endorse(client, someone_else, "cs.LG")[1].status_code == 201

    rows = _listing(client, newcomer).json()

    assert [(row["endorsee_did"], row["category"]) for row in rows] == [(newcomer, "cs.AI")]


def test_a_did_with_no_endorsements_gets_an_empty_list(client):
    response = _listing(client, _new_did())

    assert response.status_code == 200, response.text
    assert response.json() == []
