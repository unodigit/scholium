"""Tests for accepting ``paper.genesis`` records (feature 49).

A genesis is accepted only from an author of tier 2 or higher who holds an
active endorsement in *every* category the record lists; accepting it saves the
paper to the ``papers`` table with its categories, its licence (``CC-BY-4.0``
when none is named) and the ``sch:`` short id derived from the record's cid.
Anything else is refused with problem details, and the record must never reach
the ledger.

Isolation: every test builds its own Ed25519 author, its own categories (a
random suffix, so endorsements never leak between tests) and its own title (so
its own cid), because the worker's database is shared.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db
from app.modules import ingest
from app.modules.endorsements import save_endorsement
from app.modules.identity.models import Account, ensure_account_table
from app.modules.ingest import InvalidRecord
from app.modules.submissions import (
    CATEGORY_NOT_ENDORSED,
    DEFAULT_LICENCE,
    GENESIS_MIN_TIER,
    PAPER_GENESIS_TYPE,
    SHORT_ID_COLLISION,
    CategoryNotEndorsed,
    Paper,
    ShortIdCollision,
    ensure_tables,
    genesis_categories,
    genesis_licence,
    get_paper,
    get_paper_by_short_id,
    handle_paper_genesis,
    save_paper,
    unendorsed_categories,
)
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def naive_utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def categories(count: int = 1) -> list[str]:
    """Categories unique to one test (a valid name per the genesis schema)."""
    suffix = uuid.uuid4().hex
    return [f"cs.T{index}.{suffix}" for index in range(count)]


def set_tier(did: str, tier: int) -> None:
    """Give ``did`` an account of exactly ``tier`` (creating or overwriting it)."""
    ensure_account_table()
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        if account is None:
            session.add(Account(did=did, tier=tier, created_at=naive_utcnow()))
        else:
            account.tier = tier
        session.commit()


def endorse(did: str, *names: str, expires_at: object = None, endorsee: str | None = None) -> None:
    """Endorse ``did`` in each category (which also grants it tier 2)."""
    for name in names:
        save_endorsement(
            record_cid=f"cid-{uuid.uuid4().hex}",
            endorser_did=did_key_from_signing_key(SigningKey.generate()),
            endorsee_did=endorsee or did,
            category=name,
            expires_at=expires_at,
        )


class Author:
    """A signed-in author who can build correctly signed ``paper.genesis`` records."""

    def __init__(self) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 0)}"}

    def body(self, names: list[str], **overrides) -> dict:
        body = {
            "title": f"A verifiable preprint {uuid.uuid4().hex}",
            "categories": names,
            "licence": "CC-BY-4.0",
        }
        body.update(overrides)
        return {key: value for key, value in body.items() if value is not _OMIT}

    def record(self, names: list[str], **overrides) -> dict:
        unsigned = {
            "v": 1,
            "type": PAPER_GENESIS_TYPE,
            "author": self.did,
            "created": now(),
            "prev": None,
            "body": self.body(names, **overrides),
            "proofs": [],
        }
        return sign_record(unsigned, self.seed)


#: Marks a body field to leave out of the record.
_OMIT = object()


def endorsed_author(*names: str) -> Author:
    author = Author()
    endorse(author.did, *names)
    return author


def assert_problem(response, status: int) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["content-type"].startswith(PROBLEM_JSON), response.headers
    body = response.json()
    assert body["status"] == status, body
    assert isinstance(body.get("title"), str) and body["title"], body
    return body


def assert_not_in_ledger(client, cid: str) -> None:
    response = client.get(f"/v1/records/{cid}")
    assert response.status_code == 404, response.text


def insert_paper(**values) -> None:
    """Insert a ``papers`` row directly, bypassing the handler."""
    ensure_tables()
    with db.SessionLocal() as session:
        session.add(Paper(**values))
        session.commit()


# --------------------------------------------------------------------------- #
# The success path
# --------------------------------------------------------------------------- #


def test_a_tier_2_author_endorsed_in_every_category_is_accepted(client):
    names = categories(2)
    author = endorsed_author(*names)
    record = author.record(names)

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"] == record["id"]
    assert body["state"] == "accepted"
    assert body["shortId"] == derive_short_id(record["id"])
    # The record reached the ledger, envelope intact.
    stored = client.get(f"/v1/records/{record['id']}")
    assert stored.status_code == 200, stored.text
    assert stored.json()["body"] == record["body"]


def test_the_paper_is_saved_with_its_categories_licence_and_short_id(client):
    names = categories(2)
    author = endorsed_author(*names)
    record = author.record(names, licence="CC-BY-SA-4.0")

    response = client.post(URL, json=record, headers=author.headers)
    assert response.status_code == 201, response.text

    paper = get_paper(record["id"])
    assert paper is not None
    assert paper.paper_cid == record["id"]
    assert paper.categories == names
    assert paper.licence == "CC-BY-SA-4.0"
    assert paper.short_id == derive_short_id(record["id"])
    assert paper.short_id == response.json()["shortId"]
    assert paper.short_id.startswith("sch:")


def test_a_new_paper_starts_as_an_unlisted_claimed_preprint(client):
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names)

    assert client.post(URL, json=record, headers=author.headers).status_code == 201

    paper = get_paper(record["id"])
    assert paper.status == "preprint"
    assert paper.latest_version_cid is None
    assert paper.listed_at is None
    assert paper.claimed is True


def test_the_paper_can_be_found_by_its_short_id(client):
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names)
    response = client.post(URL, json=record, headers=author.headers)
    assert response.status_code == 201, response.text

    found = get_paper_by_short_id(response.json()["shortId"])

    assert found is not None
    assert found.paper_cid == record["id"]
    assert get_paper_by_short_id("sch:aaaa-aaaa-aaaa") is None


def test_the_licence_is_stored_as_the_record_states_it(client):
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names, licence="CC0-1.0")

    assert client.post(URL, json=record, headers=author.headers).status_code == 201

    assert get_paper(record["id"]).licence == "CC0-1.0"


def test_an_endorsement_that_has_not_expired_counts(client):
    names = categories()
    author = Author()
    endorse(author.did, *names, expires_at=naive_utcnow() + timedelta(days=30))

    response = client.post(URL, json=author.record(names), headers=author.headers)

    assert response.status_code == 201, response.text


def test_optional_body_fields_do_not_get_in_the_way(client):
    names = categories()
    author = endorsed_author(*names)
    record = author.record(
        names,
        abstract="We show it.",
        keywords=["verification"],
        authors=[author.did],
        seed="a-client-seed",
    )

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    assert get_paper(record["id"]).categories == names


# --------------------------------------------------------------------------- #
# The licence default
# --------------------------------------------------------------------------- #


def test_the_default_licence_is_cc_by_4_0():
    assert DEFAULT_LICENCE == "CC-BY-4.0"


def test_a_genesis_that_names_no_licence_is_stored_as_cc_by_4_0():
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names, licence=_OMIT)
    assert "licence" not in record["body"]

    assert handle_paper_genesis(record) == "accepted"

    assert get_paper(record["id"]).licence == "CC-BY-4.0"


def test_a_null_licence_is_the_default_too():
    assert genesis_licence({"licence": None}) == DEFAULT_LICENCE
    assert genesis_licence({}) == DEFAULT_LICENCE


def test_save_paper_defaults_the_licence():
    names = categories()
    cid = endorsed_author(*names).record(names)["id"]

    paper = save_paper(paper_cid=cid, categories=names)

    assert paper.licence == "CC-BY-4.0"


def test_the_licence_column_defaults_to_cc_by_4_0_for_any_writer():
    ensure_tables()
    cid = Author().record(categories())["id"]

    insert_paper(paper_cid=cid, short_id=derive_short_id(cid), categories=["x"])

    paper = get_paper(cid)
    assert paper.licence == "CC-BY-4.0"
    assert paper.status == "preprint"
    assert paper.claimed is True


@pytest.mark.parametrize("value", ["", "   ", 5, ["CC0-1.0"], True])
def test_a_present_but_unusable_licence_is_a_422_and_not_defaulted(value):
    with pytest.raises(InvalidRecord) as caught:
        genesis_licence({"licence": value})
    assert caught.value.status_code == 422
    assert caught.value.errors[0]["loc"] == ["body", "licence"]


def test_a_licence_is_trimmed():
    assert genesis_licence({"licence": "  CC0-1.0 "}) == "CC0-1.0"


# --------------------------------------------------------------------------- #
# Criterion: the author must be tier 2
# --------------------------------------------------------------------------- #


def test_registration_requires_tier_2():
    registration = ingest.get(PAPER_GENESIS_TYPE)
    assert registration is not None
    assert registration.handler is handle_paper_genesis
    assert int(registration.min_tier) == GENESIS_MIN_TIER == 2


def test_an_author_with_no_account_is_refused_with_403(client):
    names = categories()
    author = Author()
    record = author.record(names)

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["required_tier"] == 2
    assert get_paper(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_a_tier_1_author_is_refused_even_when_endorsed(client):
    names = categories()
    author = endorsed_author(*names)
    set_tier(author.did, 1)
    record = author.record(names)

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["required_tier"] == 2
    assert "tier 2" in body["detail"]
    assert get_paper(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_the_handler_enforces_the_tier_itself():
    names = categories()
    author = endorsed_author(*names)
    set_tier(author.did, 1)
    record = author.record(names)

    with pytest.raises(ingest.InsufficientAuthorTier):
        handle_paper_genesis(record)

    assert get_paper(record["id"]) is None


def test_a_higher_tier_does_not_replace_the_endorsement(client):
    names = categories()
    author = Author()
    set_tier(author.did, 4)
    record = author.record(names)

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["type"] == CATEGORY_NOT_ENDORSED
    assert get_paper(record["id"]) is None


# --------------------------------------------------------------------------- #
# Criterion: the author must be endorsed in every category
# --------------------------------------------------------------------------- #


def test_an_author_endorsed_in_none_of_the_categories_is_refused(client):
    names = categories(2)
    author = Author()
    set_tier(author.did, 2)
    record = author.record(names)

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["type"] == CATEGORY_NOT_ENDORSED
    assert body["unendorsed_categories"] == names
    assert get_paper(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_one_unendorsed_category_refuses_the_whole_record(client):
    endorsed, missing = categories(2)
    author = endorsed_author(endorsed)
    record = author.record([endorsed, missing])

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["type"] == CATEGORY_NOT_ENDORSED
    assert body["unendorsed_categories"] == [missing]
    assert missing in body["detail"]
    assert endorsed not in body["detail"]
    assert [error["loc"] for error in body["errors"]] == [["body", "categories", 1]]
    assert body["errors"][0]["input"] == missing
    assert get_paper(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_every_unendorsed_category_is_named(client):
    first, second, third = categories(3)
    author = endorsed_author(second)
    record = author.record([first, second, third])

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["unendorsed_categories"] == [first, third]
    assert [error["loc"][-1] for error in body["errors"]] == [0, 2]
    assert first in body["detail"] and third in body["detail"]


def test_an_expired_endorsement_does_not_count(client):
    names = categories()
    author = Author()
    endorse(author.did, *names, expires_at=naive_utcnow() - timedelta(days=1))
    set_tier(author.did, 2)
    record = author.record(names)

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["unendorsed_categories"] == names
    assert get_paper(record["id"]) is None


def test_another_authors_endorsement_does_not_count(client):
    names = categories()
    endorsed_author(*names)  # someone else holds the endorsement
    author = Author()
    set_tier(author.did, 2)
    record = author.record(names)

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["type"] == CATEGORY_NOT_ENDORSED
    assert get_paper(record["id"]) is None


def test_an_endorsement_for_a_different_category_does_not_count(client):
    wanted, other = categories(2)
    author = endorsed_author(other)
    record = author.record([wanted])

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 403)
    assert body["unendorsed_categories"] == [wanted]


def test_the_endorsement_check_is_made_against_the_author_not_the_caller(client):
    """A relay holding an endorsement cannot submit for an author without one."""
    names = categories()
    relay = endorsed_author(*names)
    author = Author()
    set_tier(author.did, 2)
    record = author.record(names)

    response = client.post(URL, json=record, headers=relay.headers)

    body = assert_problem(response, 403)
    assert body["type"] == CATEGORY_NOT_ENDORSED
    assert get_paper(record["id"]) is None


def test_unendorsed_categories_reports_positions():
    first, second = categories(2)
    author = endorsed_author(second)

    assert unendorsed_categories(author.did, [first, second]) == [(0, first)]
    assert unendorsed_categories(author.did, [second]) == []
    assert unendorsed_categories(None, [first]) == [(0, first)]


def test_the_handler_raises_category_not_endorsed():
    names = categories()
    author = Author()
    set_tier(author.did, 2)

    with pytest.raises(CategoryNotEndorsed) as caught:
        handle_paper_genesis(author.record(names))

    assert caught.value.status_code == 403
    assert caught.value.unendorsed_categories == names
    assert isinstance(caught.value, PermissionError)


# --------------------------------------------------------------------------- #
# Repeats and collisions
# --------------------------------------------------------------------------- #


def test_a_duplicate_submission_is_a_409_and_changes_nothing(client):
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names)
    assert client.post(URL, json=record, headers=author.headers).status_code == 201
    before = get_paper(record["id"])

    response = client.post(URL, json=record, headers=author.headers)

    assert_problem(response, 409)
    after = get_paper(record["id"])
    assert (after.short_id, after.categories, after.licence) == (
        before.short_id,
        before.categories,
        before.licence,
    )


def test_saving_is_idempotent_so_a_retry_after_a_failed_append_succeeds(client):
    """The row saved by an earlier attempt is kept; the retry reaches the ledger."""
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names)
    assert handle_paper_genesis(record) == "accepted"  # saved, never appended
    assert_not_in_ledger(client, record["id"])
    before = get_paper(record["id"])

    response = client.post(URL, json=record, headers=author.headers)

    assert response.status_code == 201, response.text
    assert client.get(f"/v1/records/{record['id']}").status_code == 200
    assert get_paper(record["id"]).short_id == before.short_id


def test_save_paper_keeps_the_existing_row():
    names = categories()
    cid = endorsed_author(*names).record(names)["id"]
    first = save_paper(paper_cid=cid, categories=names, licence="CC0-1.0")

    again = save_paper(paper_cid=cid, categories=["other"], licence="CC-BY-4.0")

    assert again.paper_cid == first.paper_cid
    assert again.categories == names
    assert again.licence == "CC0-1.0"


def test_a_short_id_held_by_another_paper_is_a_409_and_stores_nothing(client):
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names)
    short_id = derive_short_id(record["id"])
    insert_paper(
        paper_cid=f"someone-else-{uuid.uuid4().hex}",
        short_id=short_id,
        categories=["x"],
        licence="CC0-1.0",
        status="preprint",
    )

    response = client.post(URL, json=record, headers=author.headers)

    body = assert_problem(response, 409)
    assert body["type"] == SHORT_ID_COLLISION
    assert short_id in body["detail"]
    assert get_paper(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_save_paper_raises_short_id_collision():
    names = categories()
    cid = endorsed_author(*names).record(names)["id"]
    insert_paper(
        paper_cid=f"someone-else-{uuid.uuid4().hex}",
        short_id=derive_short_id(cid),
        categories=["x"],
        licence="CC0-1.0",
        status="preprint",
    )

    with pytest.raises(ShortIdCollision) as caught:
        save_paper(paper_cid=cid, categories=names)

    assert caught.value.short_id == derive_short_id(cid)
    assert get_paper(cid) is None


# --------------------------------------------------------------------------- #
# Reading the body directly
# --------------------------------------------------------------------------- #


def test_categories_are_stored_in_order_without_repeats():
    first, second = categories(2)
    author = endorsed_author(first, second)
    record = author.record([second, first, second])

    assert handle_paper_genesis(record) == "accepted"

    assert get_paper(record["id"]).categories == [second, first]


@pytest.mark.parametrize("value", [None, [], "cs.AI", ["cs.AI", ""], ["cs.AI", 3], [None], {"a": 1}])
def test_unusable_categories_are_a_422(value):
    with pytest.raises(InvalidRecord) as caught:
        genesis_categories({"categories": value})
    assert caught.value.status_code == 422
    assert caught.value.errors[0]["loc"] == ["body", "categories"]


def test_a_missing_categories_field_is_a_422():
    with pytest.raises(InvalidRecord):
        genesis_categories({})


def test_a_bad_body_saves_nothing():
    author = Author()
    endorse(author.did, *categories())
    record = author.record(categories(), licence="   ")

    with pytest.raises(InvalidRecord):
        handle_paper_genesis(record)

    assert get_paper(record["id"]) is None


def test_a_record_without_a_usable_cid_is_a_422():
    names = categories()
    author = endorsed_author(*names)
    record = author.record(names)

    for bad in (None, "", "not-a-cid"):
        broken = dict(record, id=bad)
        with pytest.raises(InvalidRecord):
            handle_paper_genesis(broken)
    assert get_paper(record["id"]) is None


def test_a_body_that_is_not_an_object_is_a_422():
    names = categories()
    author = endorsed_author(*names)
    record = dict(author.record(names), body=["not", "an", "object"])

    with pytest.raises(InvalidRecord):
        handle_paper_genesis(record)


def test_save_paper_refuses_a_non_record_cid_and_no_categories():
    with pytest.raises(ValueError):
        save_paper(paper_cid="not-a-cid", categories=["cs.AI"])
    cid = Author().record(categories())["id"]
    with pytest.raises(ValueError):
        save_paper(paper_cid=cid, categories=[])
    assert get_paper(cid) is None


def test_get_paper_tolerates_junk_arguments():
    assert get_paper(None) is None
    assert get_paper("") is None
    assert get_paper(5) is None
    assert get_paper_by_short_id(None) is None
    assert get_paper_by_short_id("") is None
