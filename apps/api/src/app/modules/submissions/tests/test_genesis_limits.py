"""Tests for the young-tier-2 genesis limit (feature 51).

A tier-2 (Author) account younger than 90 days may start one paper per week.
A ``paper.genesis`` beyond that is refused with ``429`` problem details that
name the next allowed date, and nothing is stored.  Established accounts, and
accounts of a higher tier, are not limited by this rule.

Isolation matches ``test_paper_genesis``: every test builds its own signed
author and its own categories/title, because the worker's database is shared.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record

from app import db
from app.modules import ledger
from app.modules.endorsements import save_endorsement
from app.modules.identity.models import Account, ensure_account_table
from app.modules.ledger.models import EventLog, ensure_table as ensure_event_log
from app.modules.submissions import PAPER_GENESIS_TYPE, get_paper, handle_paper_genesis
from app.modules.submissions.errors import GENESIS_RATE_LIMITED, GenesisRateLimited
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"

WEEK = timedelta(days=7)
YOUNG_LIMIT_AGE = timedelta(days=90)


def naive_utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def categories() -> list[str]:
    return [f"cs.Limit.{uuid.uuid4().hex}"]


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
                "title": f"A limited preprint {uuid.uuid4().hex}",
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


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    return body


def append_genesis(record: dict, *, received_at: datetime | None = None) -> str:
    """Append an accepted genesis through the ledger, keeping the hash chain intact."""
    ledger.append(record, received_at=received_at)
    return record["id"]


def genesis_received_at(record_cid: str) -> datetime:
    """The ledger's ``received_at`` for an accepted genesis, as aware UTC."""
    ensure_event_log()
    with db.SessionLocal() as session:
        when = (
            session.query(EventLog.received_at)
            .filter(EventLog.record_cid == record_cid)
            .scalar()
        )
    return when if when.tzinfo is not None else when.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# The rule: one genesis per week for young tier-2 accounts
# --------------------------------------------------------------------------- #


def test_a_young_tier_2_account_may_submit_its_first_genesis(client):
    author, category = young_author()

    response = client.post(URL, json=author.record(category), headers=author.headers)

    assert response.status_code == 201, response.text


def test_a_second_genesis_within_a_week_is_a_429_and_stores_nothing(client):
    author, category = young_author()
    first = author.record(category)
    assert client.post(URL, json=first, headers=author.headers).status_code == 201

    second = author.record(category)
    response = client.post(URL, json=second, headers=author.headers)

    body = assert_problem(response, 429)
    assert body["type"] == GENESIS_RATE_LIMITED
    assert body["title"] == "Too Many Requests"
    assert body["detail"]
    assert get_paper(second["id"]) is None
    assert client.get(f"/v1/records/{second['id']}").status_code == 404


def test_the_429_names_the_next_allowed_date(client):
    author, category = young_author()
    first = author.record(category)
    assert client.post(URL, json=first, headers=author.headers).status_code == 201
    accepted_at = genesis_received_at(first["id"])

    response = client.post(URL, json=author.record(category), headers=author.headers)
    body = assert_problem(response, 429)

    assert "next_allowed_at" in body, body
    next_allowed = datetime.fromisoformat(body["next_allowed_at"].replace("Z", "+00:00"))
    assert next_allowed == accepted_at + WEEK
    # The alias clients may read instead names the same instant.
    assert body["next_allowed_date"] == body["next_allowed_at"]
    assert 0 < body["retry_after"] <= int(WEEK.total_seconds())
    assert response.headers["Retry-After"] == str(body["retry_after"])


def test_a_genesis_older_than_a_week_does_not_block_a_new_one(client):
    author, category = young_author()
    append_genesis(
        author.record(category), received_at=naive_utcnow() - WEEK - timedelta(minutes=1)
    )

    response = client.post(URL, json=author.record(category), headers=author.headers)

    assert response.status_code == 201, response.text


def test_another_authors_genesis_does_not_block(client):
    other, other_category = young_author()
    assert client.post(
        URL, json=other.record(other_category), headers=other.headers
    ).status_code == 201

    author, category = young_author()
    response = client.post(URL, json=author.record(category), headers=author.headers)

    assert response.status_code == 201, response.text


def test_a_refused_genesis_does_not_spend_the_week(client):
    author, category = young_author()

    refused = client.post(
        URL, json=author.record(categories()[0]), headers=author.headers
    )
    assert refused.status_code == 403, refused.text

    allowed = client.post(URL, json=author.record(category), headers=author.headers)

    assert allowed.status_code == 201, allowed.text


# --------------------------------------------------------------------------- #
# Who the rule applies to
# --------------------------------------------------------------------------- #


def test_an_account_older_than_90_days_is_not_limited(client):
    author = Author()
    category = categories()[0]
    endorse(author.did, category)
    set_account(
        author.did, created_at=naive_utcnow() - YOUNG_LIMIT_AGE - timedelta(days=1)
    )

    first = client.post(URL, json=author.record(category), headers=author.headers)
    second = client.post(URL, json=author.record(category), headers=author.headers)

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text


def test_an_account_exactly_90_days_old_is_not_limited(client):
    author = Author()
    category = categories()[0]
    endorse(author.did, category)
    set_account(author.did, created_at=naive_utcnow() - YOUNG_LIMIT_AGE)

    first = client.post(URL, json=author.record(category), headers=author.headers)
    second = client.post(URL, json=author.record(category), headers=author.headers)

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text


@pytest.mark.parametrize("tier", [3, 4])
def test_a_higher_tier_account_is_not_limited(client, tier):
    author, category = young_author(tier=tier)

    first = client.post(URL, json=author.record(category), headers=author.headers)
    second = client.post(URL, json=author.record(category), headers=author.headers)

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text


def test_a_tier_1_author_is_still_refused_for_its_tier(client):
    author, category = young_author()
    set_account(author.did, tier=1, created_at=naive_utcnow() - timedelta(days=1))

    response = client.post(URL, json=author.record(category), headers=author.headers)

    body = assert_problem(response, 403)
    assert body["required_tier"] == 2


# --------------------------------------------------------------------------- #
# The handler and its error
# --------------------------------------------------------------------------- #


def test_the_handler_raises_genesis_rate_limited_directly():
    author, category = young_author()
    append_genesis(author.record(category), received_at=naive_utcnow())

    with pytest.raises(GenesisRateLimited) as caught:
        handle_paper_genesis(author.record(category))

    assert caught.value.status_code == 429
    assert caught.value.extensions["next_allowed_at"]


def test_retrying_the_same_genesis_record_stays_idempotent():
    """A repeat of the very same cid is the same paper, not a second genesis."""
    author, category = young_author()
    record = author.record(category)
    append_genesis(record, received_at=naive_utcnow())

    assert handle_paper_genesis(record) == "accepted"
