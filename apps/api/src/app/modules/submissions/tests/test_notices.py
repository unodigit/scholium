"""Tests for accepting withdrawal, correction and retraction records (feature 53).

A notice is accepted from an author of the paper or from a tier-4 member and is
saved to the ``notices`` table under the *paper's* cid, so every version shows
it.  Anyone else is refused with ``403``; a target that is no paper or version
here, a mismatched ``paper``, or a missing or unreadable reason is a ``422``.

Isolation: every test builds its own Ed25519 accounts and its own paper, as the
genesis and version tests do, because the worker's database is shared.  A paper
is put in place through the real genesis and version paths, so the handlers see
the same ``papers`` rows, ``authorship`` rows and ledger entries production has.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key, sign_record
from sqlalchemy import inspect

from app import db
from app.modules import content, ingest, ledger
from app.modules.endorsements import save_endorsement
from app.modules.identity.models import Account, ensure_account_table
from app.modules.submissions import (
    CORRECTION_TYPE,
    MAX_REASON_BYTES,
    NOTICE_MIN_TIER,
    NOTICE_NOT_AUTHORIZED,
    NOTICE_OVERRIDE_TIER,
    NOTICE_TYPES,
    PAPER_GENESIS_TYPE,
    PAPER_VERSION_TYPE,
    RETRACTION_TYPE,
    UNKNOWN_NOTICE_TARGET,
    WITHDRAWAL_TYPE,
    Notice,
    NoticeNotAuthorized,
    UnknownNoticeTarget,
    ensure_tables,
    get_notice,
    get_paper,
    handle_correction,
    handle_retraction,
    handle_withdrawal,
    latest_version,
    notices_for_paper,
    paper_authors,
    resolve_target,
    save_notice,
)
from app.security import issue_access_token

URL = "/v1/records"
PROBLEM_JSON = "application/problem+json"

HANDLERS = {
    WITHDRAWAL_TYPE: handle_withdrawal,
    CORRECTION_TYPE: handle_correction,
    RETRACTION_TYPE: handle_retraction,
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def set_tier(did: str, tier: int, *, age_days: int = 0) -> None:
    """Give ``did`` an account of exactly ``tier``, created ``age_days`` ago.

    Creates or overwrites the account.  ``age_days`` matters only to the
    weekly genesis limit, which a tier-2 account younger than 90 days is under.
    """
    ensure_account_table()
    created_at = (datetime.now(timezone.utc) - timedelta(days=age_days)).replace(tzinfo=None)
    with db.SessionLocal() as session:
        account = session.get(Account, did)
        if account is None:
            session.add(Account(did=did, tier=tier, created_at=created_at))
        else:
            account.tier = tier
            account.created_at = created_at
        session.commit()


def endorse(did: str, *categories: str) -> None:
    """Endorse ``did`` in each category (which also grants it tier 2)."""
    for category in categories:
        save_endorsement(
            record_cid=f"cid-{uuid.uuid4().hex}",
            endorser_did=did_key_from_signing_key(SigningKey.generate()),
            endorsee_did=did,
            category=category,
        )


class Account_:
    """A signing identity that can sign any record type and relay records."""

    def __init__(self, tier: int | None = None) -> None:
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.headers = {"Authorization": f"Bearer {issue_access_token(self.did, 0)}"}
        if tier is not None:
            set_tier(self.did, tier)

    def record(
        self,
        record_type: str,
        body: dict,
        *,
        prev: str | None = None,
        created: str | None = None,
    ) -> dict:
        """A complete record: ``id`` is the recomputed cid, ``sig`` is this account's."""
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": created if created is not None else now(),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )


def publish_paper(client, author: Account_) -> str:
    """Post one accepted ``paper.genesis``; return the paper's cid."""
    names = [f"cs.T0.{uuid.uuid4().hex}"]
    endorse(author.did, *names)
    # An established account: a tier-2 account younger than 90 days may start
    # only one paper a week, and several tests here need an author with two.
    set_tier(author.did, 2, age_days=120)
    genesis = author.record(
        PAPER_GENESIS_TYPE,
        {
            "title": f"A paper that gains notices {uuid.uuid4().hex}",
            "categories": names,
            "licence": "CC-BY-4.0",
        },
    )
    response = client.post(URL, json=genesis, headers=author.headers)
    assert response.status_code == 201, response.text
    return genesis["id"]


def publish_version(client, author: Account_, paper_cid: str, n: int, authors: list) -> dict:
    """Post one accepted ``paper.version`` listing ``authors``; return the signed record."""
    latest = latest_version(paper_cid)
    record = author.record(
        PAPER_VERSION_TYPE,
        {
            "paper": paper_cid,
            "n": n,
            "title": f"Version {n} {uuid.uuid4().hex}",
            "abstract": "An abstract.",
            "authors": authors,
            "manifest": f"bafkreimanifest{uuid.uuid4().hex}",
            "licence": "CC-BY-4.0",
            "changeNote": f"Change {n}.",
        },
        prev=latest.version_cid if latest is not None else paper_cid,
    )
    response = client.post(URL, json=record, headers=author.headers)
    assert response.status_code == 201, response.text
    return record


def notice(signer: Account_, kind: str, target: str, **body) -> dict:
    """A signed notice of ``kind`` against ``target`` with a plain reason."""
    fields = {"target": target, "reason": f"Because {uuid.uuid4().hex}."}
    fields.update(body)
    return signer.record(kind, {key: value for key, value in fields.items() if value is not None})


def post(client, record: dict, relay: Account_ | None = None):
    """Post ``record``, relayed by ``relay`` (default: the record's own signer)."""
    headers = relay.headers if relay is not None else {
        "Authorization": f"Bearer {issue_access_token(record['author'], 0)}"
    }
    return client.post(URL, json=record, headers=headers)


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


@pytest.fixture
def author() -> Account_:
    return Account_()


@pytest.fixture
def paper(client, author) -> str:
    """An accepted paper owned by ``author`` (who is therefore tier 2)."""
    return publish_paper(client, author)


kinds = pytest.mark.parametrize("kind", NOTICE_TYPES)


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #


def test_the_three_notice_types_are_the_record_types_of_the_spec():
    assert NOTICE_TYPES == ("withdrawal", "correction", "retraction")


@kinds
def test_each_type_is_registered_with_its_handler(kind):
    registration = ingest.get(kind)
    assert registration is not None
    assert registration.handler is HANDLERS[kind]
    # Who may sign is decided by the handler, not by a tier floor: a co-author
    # may be tier 1, so a floor of 2 would refuse authors.
    assert int(registration.min_tier) == NOTICE_MIN_TIER == 0


def test_the_override_tier_is_tier_4():
    assert NOTICE_OVERRIDE_TIER == 4


# --------------------------------------------------------------------------- #
# The notices table
# --------------------------------------------------------------------------- #


def test_the_notices_table_has_the_spec_columns():
    ensure_tables()
    columns = {column["name"]: column for column in inspect(db.engine).get_columns("notices")}

    assert list(columns) == ["record_cid", "paper_cid", "kind", "reason", "created_at"]
    assert all(not column["nullable"] for column in columns.values())
    assert inspect(db.engine).get_pk_constraint("notices")["constrained_columns"] == ["record_cid"]


# --------------------------------------------------------------------------- #
# The success path
# --------------------------------------------------------------------------- #


@kinds
def test_the_paper_author_can_post_a_notice(client, author, paper, kind):
    record = notice(author, kind, paper, reason="The dataset was mislabelled.")

    response = post(client, record)

    assert response.status_code == 201, response.text
    assert response.json()["id"] == record["id"]
    assert response.json()["state"] == "accepted"
    stored = client.get(f"/v1/records/{record['id']}")
    assert stored.status_code == 200, stored.text
    assert stored.json()["body"] == record["body"]


@kinds
def test_the_notice_is_saved_to_the_notices_table(client, author, paper, kind):
    record = notice(author, kind, paper, reason="The dataset was mislabelled.")

    assert post(client, record).status_code == 201

    row = get_notice(record["id"])
    assert row is not None
    assert row.record_cid == record["id"]
    assert row.paper_cid == paper
    assert row.kind == kind
    assert row.reason == "The dataset was mislabelled."


def test_created_at_is_the_records_own_date_in_utc(client, author, paper):
    record = author.record(
        RETRACTION_TYPE,
        {"target": paper, "reason": "Superseded."},
        created="2026-03-02T10:30:00+02:00",
    )

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).created_at == datetime(2026, 3, 2, 8, 30, 0)


def test_a_created_without_an_offset_is_read_as_utc(client, author, paper):
    record = author.record(
        CORRECTION_TYPE,
        {"target": paper, "reason": "Typo."},
        created="2026-03-02T10:30:00",
    )

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).created_at == datetime(2026, 3, 2, 10, 30, 0)


def test_the_reason_is_stored_trimmed(client, author, paper):
    record = notice(author, WITHDRAWAL_TYPE, paper, reason="  Withdrawn by us.  \n")

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).reason == "Withdrawn by us."


def test_a_replacement_does_not_change_what_is_stored(client, author, paper):
    replacement = publish_paper(client, author)
    record = notice(author, RETRACTION_TYPE, paper, replacement=replacement)

    assert post(client, record).status_code == 201

    row = get_notice(record["id"])
    assert (row.paper_cid, row.kind) == (paper, RETRACTION_TYPE)
    # The replacement lives in the signed record, which the ledger serves.
    assert client.get(f"/v1/records/{record['id']}").json()["body"]["replacement"] == replacement


def test_a_retraction_notice_is_saved_to_the_papers_status_by_the_status_plugin(client, author, paper):
    """The handler saves the notice; ``papers.status`` follows via the status plugin's ledger subscription."""
    assert get_paper(paper).status == "preprint"

    assert post(client, notice(author, RETRACTION_TYPE, paper)).status_code == 201

    assert get_paper(paper).status == "retracted"


# --------------------------------------------------------------------------- #
# Every version shows the notice
# --------------------------------------------------------------------------- #


def test_a_notice_naming_a_version_belongs_to_the_whole_paper(client, author, paper):
    v1 = publish_version(client, author, paper, 1, [author.did])
    v2 = publish_version(client, author, paper, 2, [author.did])
    record = notice(author, CORRECTION_TYPE, v1["id"], reason="Figure 2 was mislabelled.")

    assert post(client, record).status_code == 201

    row = get_notice(record["id"])
    assert row.paper_cid == paper  # the paper's genesis cid, not the version's
    shown = notices_for_paper(paper)
    assert [item.record_cid for item in shown] == [record["id"]]
    # Version 2 was never named, and still shows it: the lookup is by paper.
    assert latest_version(paper).version_cid == v2["id"]
    assert resolve_target(CORRECTION_TYPE, v2["id"]).paper_cid == paper


def test_a_notice_naming_the_paper_is_the_same_notice_for_every_version(client, author, paper):
    publish_version(client, author, paper, 1, [author.did])
    record = notice(author, WITHDRAWAL_TYPE, paper)
    assert post(client, record).status_code == 201
    publish_version(client, author, paper, 2, [author.did])

    assert [item.record_cid for item in notices_for_paper(paper)] == [record["id"]]


def test_notices_for_a_paper_are_oldest_first_and_only_its_own(client, author, paper):
    other_paper = publish_paper(client, author)
    later = author.record(
        RETRACTION_TYPE, {"target": paper, "reason": "later"}, created="2026-05-01T00:00:00Z"
    )
    earlier = author.record(
        CORRECTION_TYPE, {"target": paper, "reason": "earlier"}, created="2026-04-01T00:00:00Z"
    )
    elsewhere = notice(author, WITHDRAWAL_TYPE, other_paper)
    for record in (later, earlier, elsewhere):
        assert post(client, record).status_code == 201

    assert [item.record_cid for item in notices_for_paper(paper)] == [earlier["id"], later["id"]]
    assert [item.record_cid for item in notices_for_paper(other_paper)] == [elsewhere["id"]]


def test_a_paper_without_notices_shows_none():
    assert notices_for_paper(f"bafyreinone{uuid.uuid4().hex}") == []
    assert notices_for_paper(None) == []
    assert notices_for_paper("") == []


# --------------------------------------------------------------------------- #
# Who may sign
# --------------------------------------------------------------------------- #


@kinds
def test_a_listed_coauthor_can_post_a_notice(client, author, paper, kind):
    coauthor = Account_(tier=1)  # a co-author need not be tier 2
    publish_version(client, author, paper, 1, [author.did, coauthor.did])

    # The co-author must consent before they speak for the paper.
    version_cid = latest_version(paper).version_cid
    consent = coauthor.record(
        "coauthor.consent",
        {"version": version_cid, "role": "Author", "decision": "accept"},
    )
    assert post(client, consent).status_code == 201

    response = post(client, notice(coauthor, kind, paper))

    assert response.status_code == 201, response.text


def test_a_signer_of_a_version_can_post_a_notice(client, author, paper):
    """The verifier counts whoever signed a chain version as an author of the paper."""
    publisher = Account_(tier=4)
    other = did_key_from_signing_key(SigningKey.generate())
    publish_version(client, publisher, paper, 1, [other])

    assert post(client, notice(publisher, WITHDRAWAL_TYPE, paper)).status_code == 201


@kinds
def test_a_tier_4_member_who_is_not_an_author_can_post_a_notice(client, author, paper, kind):
    moderator = Account_(tier=4)
    record = notice(moderator, kind, paper, reason="Integrity committee finding.")

    response = post(client, record)

    assert response.status_code == 201, response.text
    assert get_notice(record["id"]).paper_cid == paper


@kinds
def test_a_stranger_is_refused_with_403(client, author, paper, kind):
    stranger = Account_(tier=2)
    record = notice(stranger, kind, paper)

    response = post(client, record)

    error = assert_problem(response, 403)
    assert error["type"] == NOTICE_NOT_AUTHORIZED
    assert error["paper_cid"] == paper
    assert error["required_tier"] == 4
    assert get_notice(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


@pytest.mark.parametrize("tier", [0, 1, 2, 3])
def test_no_tier_below_4_substitutes_for_being_an_author(client, author, paper, tier):
    stranger = Account_(tier=tier)
    record = notice(stranger, RETRACTION_TYPE, paper)

    error = assert_problem(post(client, record), 403)

    assert error["type"] == NOTICE_NOT_AUTHORIZED
    assert get_notice(record["id"]) is None


def test_a_signer_with_no_account_is_refused(client, author, paper):
    nobody = Account_()  # never signed in: no ``accounts`` row, reads as tier 0
    record = notice(nobody, WITHDRAWAL_TYPE, paper)

    assert_problem(post(client, record), 403)

    assert get_notice(record["id"]) is None


def test_an_author_of_another_paper_is_refused(client, author, paper):
    other_author = Account_()
    publish_paper(client, other_author)
    record = notice(other_author, RETRACTION_TYPE, paper)

    assert_problem(post(client, record), 403)

    assert get_notice(record["id"]) is None


def test_the_signers_standing_counts_not_the_relayers(client, author, paper):
    """A tier-4 member relaying a stranger's record does not lend them tier 4."""
    stranger = Account_(tier=2)
    moderator = Account_(tier=4)
    record = notice(stranger, RETRACTION_TYPE, paper)

    assert_problem(post(client, record, relay=moderator), 403)

    assert get_notice(record["id"]) is None


def test_an_authors_notice_can_be_relayed_by_anyone(client, author, paper):
    relayer = Account_(tier=0)
    record = notice(author, WITHDRAWAL_TYPE, paper)

    assert post(client, record, relay=relayer).status_code == 201

    assert get_notice(record["id"]).paper_cid == paper


def test_paper_authors_lists_the_genesis_signer_version_signers_and_listed_authors(
    client, author, paper
):
    publisher = Account_(tier=4)
    listed = did_key_from_signing_key(SigningKey.generate())
    publish_version(client, publisher, paper, 1, [listed])

    assert paper_authors(paper) == {author.did, publisher.did}


def test_paper_authors_of_an_unknown_paper_is_empty():
    assert paper_authors(f"bafyreinone{uuid.uuid4().hex}") == frozenset()


def test_require_authorized_error_is_a_permission_error():
    error = NoticeNotAuthorized(RETRACTION_TYPE, "did:key:zNobody", "bafyreipaper", 4)

    assert isinstance(error, PermissionError)
    assert error.status_code == 403
    assert "retraction" in str(error.detail)
    assert "tier-4" in str(error.detail)


# --------------------------------------------------------------------------- #
# The target
# --------------------------------------------------------------------------- #


@kinds
def test_an_unknown_target_is_refused_with_422(client, author, paper, kind):
    # A real, correctly signed genesis cid that was never accepted here.
    unknown = author.record(
        PAPER_GENESIS_TYPE,
        {"title": "never", "categories": ["cs.T0.never"], "licence": "CC-BY-4.0"},
    )
    record = notice(author, kind, unknown["id"])

    error = assert_problem(post(client, record), 422)

    assert error["type"] == UNKNOWN_NOTICE_TARGET
    assert error["errors"][0]["loc"] == ["body", "target"]
    assert get_notice(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_a_tier_4_member_cannot_notice_a_paper_that_does_not_exist(client):
    moderator = Account_(tier=4)
    unknown = moderator.record(
        PAPER_GENESIS_TYPE,
        {"title": "never", "categories": ["cs.T0.never"], "licence": "CC-BY-4.0"},
    )

    error = assert_problem(post(client, notice(moderator, RETRACTION_TYPE, unknown["id"])), 422)

    assert error["type"] == UNKNOWN_NOTICE_TARGET


def test_a_record_that_is_not_a_paper_or_version_is_not_a_target(client, author, paper):
    """A cid the log holds for some other record type is no paper."""
    first = notice(author, WITHDRAWAL_TYPE, paper)
    assert post(client, first).status_code == 201

    record = notice(author, RETRACTION_TYPE, first["id"])  # a notice, not a paper

    error = assert_problem(post(client, record), 422)

    assert error["type"] == UNKNOWN_NOTICE_TARGET
    assert get_notice(record["id"]) is None


def test_a_paper_known_only_from_the_ledger_is_a_target(client, author):
    """A node that logs records without deriving rows can still accept notices."""
    genesis = author.record(
        PAPER_GENESIS_TYPE,
        {
            "title": f"Ledger-only paper {uuid.uuid4().hex}",
            "categories": [f"cs.T0.{uuid.uuid4().hex}"],
            "licence": "CC-BY-4.0",
        },
    )
    ledger.append(genesis)
    assert get_paper(genesis["id"]) is None
    record = notice(author, RETRACTION_TYPE, genesis["id"])

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).paper_cid == genesis["id"]


def test_resolve_target_finds_papers_and_versions(client, author, paper):
    version = publish_version(client, author, paper, 1, [author.did])

    by_paper = resolve_target(RETRACTION_TYPE, paper)
    by_version = resolve_target(RETRACTION_TYPE, version["id"])

    assert (by_paper.paper_cid, by_paper.version_cid) == (paper, None)
    assert (by_version.paper_cid, by_version.version_cid) == (paper, version["id"])


@pytest.mark.parametrize("target", [None, "", 7, ["x"], "bafyreidoesnotexist"])
def test_resolve_target_refuses_what_is_not_a_known_cid(target):
    with pytest.raises(UnknownNoticeTarget) as caught:
        resolve_target(RETRACTION_TYPE, target)
    assert caught.value.status_code == 422


def test_a_named_paper_that_matches_is_accepted(client, author, paper):
    version = publish_version(client, author, paper, 1, [author.did])
    record = notice(author, CORRECTION_TYPE, version["id"], paper=paper)

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).paper_cid == paper


def test_a_named_paper_that_is_not_the_targets_paper_is_refused(client, author, paper):
    other_paper = publish_paper(client, author)
    record = notice(author, CORRECTION_TYPE, paper, paper=other_paper)

    error = assert_problem(post(client, record), 422)

    assert error["errors"][0]["loc"] == ["body", "paper"]
    assert error["errors"][0]["type"] == "paper_target_mismatch"
    assert get_notice(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


# --------------------------------------------------------------------------- #
# The reason
# --------------------------------------------------------------------------- #


def store_reason(data: bytes) -> str:
    return content.store_bytes(data).cid


def test_a_reason_cid_is_read_from_the_content_store(client, author, paper):
    cid = store_reason("The analysis code had an off-by-one error.\n".encode())
    record = notice(author, CORRECTION_TYPE, paper, reason=None, reasonCid=cid)

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).reason == "The analysis code had an off-by-one error."


def test_a_reason_cid_may_hold_non_ascii_text(client, author, paper):
    cid = store_reason("Données invalides — 数据无效".encode())
    record = notice(author, RETRACTION_TYPE, paper, reason=None, reasonCid=cid)

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).reason == "Données invalides — 数据无效"


def test_a_non_blank_reason_wins_over_a_reason_cid(client, author, paper):
    cid = store_reason(b"the file's reason")
    record = notice(author, WITHDRAWAL_TYPE, paper, reason="the inline reason", reasonCid=cid)

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).reason == "the inline reason"


def test_a_blank_reason_falls_back_to_the_reason_cid(client, author, paper):
    cid = store_reason(b"the file's reason")
    record = notice(author, WITHDRAWAL_TYPE, paper, reason="   ", reasonCid=cid)

    assert post(client, record).status_code == 201

    assert get_notice(record["id"]).reason == "the file's reason"


def test_a_reason_cid_that_is_not_stored_is_refused(client, author, paper):
    missing = content.store.cid_from_digest(b"\x01" * 32)
    record = notice(author, RETRACTION_TYPE, paper, reason=None, reasonCid=missing)

    error = assert_problem(post(client, record), 422)

    assert error["errors"][0]["loc"] == ["body", "reasonCid"]
    assert error["errors"][0]["type"] == "reason_not_stored"
    assert get_notice(record["id"]) is None
    assert_not_in_ledger(client, record["id"])


def test_a_reason_cid_that_is_not_a_file_id_is_refused(client, author, paper):
    record = notice(author, RETRACTION_TYPE, paper, reason=None, reasonCid="not-a-cid")

    error = assert_problem(post(client, record), 422)

    assert error["errors"][0]["type"] == "reason_not_stored"


def test_a_reason_cid_larger_than_the_cap_is_refused(client, author, paper):
    cid = store_reason(b"x" * (MAX_REASON_BYTES + 1))
    record = notice(author, RETRACTION_TYPE, paper, reason=None, reasonCid=cid)

    error = assert_problem(post(client, record), 422)

    assert error["errors"][0]["type"] == "reason_too_large"
    assert get_notice(record["id"]) is None


def test_a_reason_cid_at_the_cap_is_accepted(client, author, paper):
    cid = store_reason(b"x" * MAX_REASON_BYTES)
    record = notice(author, RETRACTION_TYPE, paper, reason=None, reasonCid=cid)

    assert post(client, record).status_code == 201

    assert len(get_notice(record["id"]).reason) == MAX_REASON_BYTES


@pytest.mark.parametrize("data", [b"\xff\xfe\x00 not utf-8", b"", b"   \n\t "])
def test_a_reason_cid_that_is_not_readable_text_is_refused(client, author, paper, data):
    record = notice(author, RETRACTION_TYPE, paper, reason=None, reasonCid=store_reason(data))

    error = assert_problem(post(client, record), 422)

    assert error["errors"][0]["type"] == "reason_unreadable"
    assert get_notice(record["id"]) is None


def test_a_tombstoned_reason_cid_is_refused(client, author, paper, monkeypatch):
    cid = store_reason(b"a reason moderation removed")
    monkeypatch.setattr(content, "is_tombstoned", lambda candidate: candidate == cid)
    record = notice(author, RETRACTION_TYPE, paper, reason=None, reasonCid=cid)

    error = assert_problem(post(client, record), 422)

    assert error["errors"][0]["type"] == "reason_tombstoned"
    assert get_notice(record["id"]) is None


def test_the_content_store_is_not_read_for_a_signer_with_no_standing(client, author, paper, monkeypatch):
    """A stranger's ``reasonCid`` is refused as a 403 before any file is opened."""
    opened = []
    real_open = content.store.open_blob
    monkeypatch.setattr(
        content.store, "open_blob", lambda cid: opened.append(cid) or real_open(cid)
    )
    stranger = Account_(tier=2)
    cid = store_reason(b"a reason")
    record = notice(stranger, RETRACTION_TYPE, paper, reason=None, reasonCid=cid)

    assert_problem(post(client, record), 403)

    assert opened == []


@pytest.mark.parametrize("reason", ["", "   ", "\n\t"])
def test_a_blank_reason_without_a_reason_cid_is_refused(author, paper, reason):
    record = notice(author, RETRACTION_TYPE, paper, reason=reason)

    with pytest.raises(ingest.InvalidRecord) as caught:
        handle_retraction(record)

    assert caught.value.status_code == 422
    assert caught.value.record_errors[0]["loc"] == ["body", "reason"]
    assert caught.value.record_errors[0]["type"] == "missing_reason"


def test_a_notice_with_no_reason_at_all_is_refused_by_the_schema(client, author, paper):
    record = notice(author, RETRACTION_TYPE, paper, reason=None)

    assert_problem(post(client, record), 422)

    assert get_notice(record["id"]) is None


# --------------------------------------------------------------------------- #
# Malformed records reaching the handler directly
# --------------------------------------------------------------------------- #


def test_an_unparsable_created_is_refused(author, paper):
    record = author.record(
        RETRACTION_TYPE, {"target": paper, "reason": "x"}, created="next tuesday"
    )

    with pytest.raises(ingest.InvalidRecord) as caught:
        handle_retraction(record)

    assert caught.value.record_errors[0]["loc"] == ["created"]
    assert caught.value.record_errors[0]["type"] == "invalid_created"
    assert get_notice(record["id"]) is None


def test_a_non_object_body_is_refused(author):
    record = {"id": "bafyreix", "author": author.did, "created": now(), "body": ["x"]}

    with pytest.raises(ingest.InvalidRecord):
        handle_withdrawal(record)


@pytest.mark.parametrize("target", [None, "", 7])
def test_a_missing_or_malformed_target_is_refused(author, target):
    record = author.record(RETRACTION_TYPE, {"target": target, "reason": "x"})

    with pytest.raises(ingest.InvalidRecord) as caught:
        handle_retraction(record)

    assert caught.value.record_errors[0]["loc"] == ["body", "target"]


def test_a_record_without_an_id_is_refused(author, paper):
    record = notice(author, RETRACTION_TYPE, paper)
    del record["id"]

    with pytest.raises(ingest.InvalidRecord) as caught:
        handle_retraction(record)

    assert caught.value.record_errors[0]["type"] == "missing_record_id"


# --------------------------------------------------------------------------- #
# Saving is idempotent
# --------------------------------------------------------------------------- #


def test_posting_the_same_notice_twice_is_a_409(client, author, paper):
    record = notice(author, RETRACTION_TYPE, paper)
    assert post(client, record).status_code == 201

    assert_problem(post(client, record), 409)

    assert len(notices_for_paper(paper)) == 1


def test_a_retry_after_a_failed_ledger_append_is_accepted(author, paper):
    """The row exists but the ledger append failed: the handler reports success again."""
    record = notice(author, RETRACTION_TYPE, paper)

    assert handle_retraction(record) == "accepted"
    assert handle_retraction(record) == "accepted"

    assert [item.record_cid for item in notices_for_paper(paper)] == [record["id"]]


def test_save_notice_keeps_the_first_row(author, paper):
    created = datetime(2026, 1, 1, 12, 0, 0)
    cid = f"bafyreinotice{uuid.uuid4().hex}"

    first = save_notice(
        record_cid=cid, paper_cid=paper, kind=RETRACTION_TYPE, reason="first", created_at=created
    )
    second = save_notice(
        record_cid=cid,
        paper_cid=paper,
        kind=CORRECTION_TYPE,
        reason="second",
        created_at=datetime(2027, 1, 1),
    )

    assert (first.reason, second.reason) == ("first", "first")
    assert (second.kind, second.created_at) == (RETRACTION_TYPE, created)
    with db.SessionLocal() as session:
        assert session.query(Notice).filter(Notice.record_cid == cid).count() == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"record_cid": ""},
        {"paper_cid": ""},
        {"kind": "tombstone"},
        {"reason": ""},
        {"reason": "   "},
    ],
)
def test_save_notice_refuses_unusable_values(overrides):
    values = {
        "record_cid": f"bafyreinotice{uuid.uuid4().hex}",
        "paper_cid": "bafyreipaper",
        "kind": RETRACTION_TYPE,
        "reason": "because",
        "created_at": datetime(2026, 1, 1),
    }
    values.update(overrides)

    with pytest.raises(ValueError):
        save_notice(**values)


def test_get_notice_of_an_unknown_record_is_none():
    assert get_notice(f"bafyreinone{uuid.uuid4().hex}") is None
    assert get_notice(None) is None
    assert get_notice("") is None
