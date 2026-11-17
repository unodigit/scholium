"""Tests for ``GET /v1/submissions/eligibility``.

The weekly limit used to be reported only by the refusal at signing: the
browser had no way to ask whether the caller may start a paper *now*, so the
submit wizard said nothing until after an upload and five steps.  The route
answers the same facts the enforcement code uses -- the caller's tier, whether
they may submit, the rolling-week quota and the next allowed instant, and the
categories they are endorsed in -- before anything is uploaded.

Isolation matches ``test_genesis_limits``: every test builds its own signed
author and its own categories, because the worker's database is shared.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db
from app.modules import ledger
from app.modules.endorsements import save_endorsement
from app.modules.identity.models import Account, ensure_account_table
from app.modules.submissions import PAPER_GENESIS_TYPE
from app.security import issue_access_token

URL = "/v1/submissions/eligibility"
RECORDS_URL = "/v1/records"
WEEK = timedelta(days=7)
YOUNG_LIMIT_AGE = timedelta(days=90)
PROBLEM_JSON = "application/problem+json"


def naive_utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def categories() -> list[str]:
    return [f"cs.Eligibility.{uuid.uuid4().hex}"]


def endorse(did: str, category: str) -> None:
    save_endorsement(
        record_cid=f"cid-{uuid.uuid4().hex}",
        endorser_did=did_key_from_signing_key(SigningKey.generate()),
        endorsee_did=did,
        category=category,
    )


def set_account(did: str, *, tier: int = 2, created_at: datetime | None = None) -> None:
    """Give ``did`` an account of ``tier``, created at ``created_at`` (naive UTC)."""
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        if account is None:
            account = Account(did=did, tier=tier)
            session.add(account)
        account.tier = tier
        account.created_at = created_at if created_at is not None else naive_utcnow()
        session.commit()


class Author:
    """A signed-in author that can build correctly signed ``paper.genesis`` records."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 0)}"}

    def record(self, category: str) -> dict:
        unsigned = {
            "v": 1,
            "type": PAPER_GENESIS_TYPE,
            "author": self.did,
            "created": now(),
            "prev": None,
            "body": {
                "title": f"An eligible preprint {uuid.uuid4().hex}",
                "categories": [category],
                "licence": "CC-BY-4.0",
            },
            "proofs": [],
        }
        return sign_record(unsigned, self.seed)


def young_author(*, tier: int = 2) -> tuple[Author, str]:
    """An endorsed author whose account is a day old."""
    author = Author()
    category = categories()[0]
    endorse(author.did, category)
    set_account(author.did, tier=tier, created_at=naive_utcnow() - timedelta(days=1))
    return author, category


def append_genesis(record: dict, *, received_at: datetime | None = None) -> str:
    """Append an accepted genesis through the ledger, keeping the hash chain intact."""
    ledger.append(record, received_at=received_at)
    return record["id"]


def iso(value: datetime) -> str:
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def eligibility(client, author: Author) -> dict:
    response = client.get(URL, headers=author.headers)
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------- #
# Authentication
# --------------------------------------------------------------------------- #


def test_reading_eligibility_requires_a_signed_in_caller(client):
    response = client.get(URL)

    assert response.status_code == 401, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON)


# --------------------------------------------------------------------------- #
# The facts the wizard needs
# --------------------------------------------------------------------------- #


def test_a_young_author_with_no_paper_this_week_may_submit(client):
    author, category = young_author()

    body = eligibility(client, author)

    assert body["tier"] == 2
    assert body["may_submit"] is True
    assert body["weekly_used"] == 0
    assert body["weekly_allowed"] == 1
    assert body["next_allowed_at"] is None
    assert body["endorsed_categories"] == [category]


def test_an_accepted_genesis_shows_up_as_the_used_quota_and_the_next_allowed_date(client):
    author, category = young_author()
    accepted_at = naive_utcnow() - timedelta(days=2)
    append_genesis(author.record(category), received_at=accepted_at)

    body = eligibility(client, author)

    assert body["tier"] == 2
    assert body["may_submit"] is False
    assert body["weekly_used"] == 1
    assert body["weekly_allowed"] == 1
    assert body["next_allowed_at"] == iso(accepted_at + WEEK)
    assert body["endorsed_categories"] == [category]


def test_the_route_and_the_refusal_name_the_same_next_allowed_instant(client):
    """The endpoint reads the limits code that enforces the rule, not a copy of it."""
    author, category = young_author()

    response = client.post(RECORDS_URL, json=author.record(category), headers=author.headers)
    assert response.status_code == 201, response.text
    refused = client.post(RECORDS_URL, json=author.record(category), headers=author.headers)
    assert refused.status_code == 429, refused.text

    body = eligibility(client, author)

    assert body["next_allowed_at"] == refused.json()["next_allowed_at"]
    assert body["weekly_used"] == 1
    assert body["may_submit"] is False


def test_an_established_account_has_no_weekly_limit_but_reports_its_tier(client):
    author = Author()
    category = categories()[0]
    endorse(author.did, category)
    set_account(
        author.did,
        created_at=naive_utcnow() - YOUNG_LIMIT_AGE - timedelta(days=1),
    )
    append_genesis(author.record(category), received_at=naive_utcnow())

    body = eligibility(client, author)

    assert body["tier"] == 2
    assert body["may_submit"] is True
    assert body["next_allowed_at"] is None


def test_a_member_is_reported_as_unable_to_submit(client):
    author, category = young_author()
    set_account(author.did, tier=1, created_at=naive_utcnow() - timedelta(days=1))

    body = eligibility(client, author)

    assert body["tier"] == 1
    assert body["may_submit"] is False
    assert body["endorsed_categories"] == [category]


def test_an_unendorsed_caller_reports_no_categories(client):
    author = Author()
    set_account(author.did, tier=2, created_at=naive_utcnow() - timedelta(days=1))

    body = eligibility(client, author)

    assert body["tier"] == 2
    assert body["may_submit"] is False
    assert body["endorsed_categories"] == []
