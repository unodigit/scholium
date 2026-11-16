"""Tests for the daily email digest (plugin: follows, feature 181).

The ``follows.digest`` job emails each reader the papers first listed since
their last digest that match their follows and saved searches.  Covers what the
email lists (follows, saved searches with and without ``q``, one entry per paper
with every reason, newest first, only the reader's own matches), what "new"
means (a window that follows the reader's last digest, never repeats a paper),
who is emailed (verified profile addresses only, nothing when nothing is new),
delivery failure (the window stays open and the next run sends it), and the job
itself (it queues tomorrow's run exactly once, even when retried).

The database is shared by every test in a worker, so each test uses categories,
search terms and addresses unique to it and reads only its own readers' mail.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import pytest
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, sign_record

from app import db, jobs
from app.modules import follows
from app.modules.follows import digest
from app.modules.follows.models import DigestState
from app.modules.notifications import clear_outbox, get_outbox
from app.modules.profiles import (
    ProfileData,
    issue_verification_token,
    mark_email_verified,
    save_profile,
)
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)
from app.settings import settings

_TO_LISTED = ("scanning", "moderation")


@pytest.fixture(autouse=True)
def _assembled_app(client):
    """Assemble the app so every plugin's startup wiring (search indexing) is live."""
    yield


@pytest.fixture(autouse=True)
def _fresh_outbox():
    clear_outbox()
    yield
    clear_outbox()


@pytest.fixture(autouse=True)
def _clean_digest_jobs():
    """No queued ``follows.digest`` rows before or after a test."""
    _delete_digest_jobs()
    yield
    _delete_digest_jobs()


def _delete_digest_jobs() -> None:
    try:
        with db.SessionLocal() as session:
            session.query(jobs.Job).filter(jobs.Job.kind == digest.JOB_KIND).delete()
            session.commit()
    except Exception:  # the jobs table does not exist yet
        pass


def _queued_digest_jobs() -> list[jobs.Job]:
    with db.SessionLocal() as session:
        return list(
            session.query(jobs.Job).filter(
                jobs.Job.kind == digest.JOB_KIND, jobs.Job.status == jobs.STATUS_QUEUED
            )
        )


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ago(hours: float) -> datetime:
    return _now() - timedelta(hours=hours)


def _did() -> str:
    return "did:key:z6Mk" + uuid.uuid4().hex


def _category() -> str:
    return f"cs.T{uuid.uuid4().hex[:12]}"


def _term() -> str:
    """A single search word unique to one test."""
    return f"zq{uuid.uuid4().hex[:14]}"


def reader(*, verified: bool = True) -> tuple[str, str]:
    """A DID with a saved profile address, verified unless told otherwise."""
    did, address = _did(), f"{uuid.uuid4().hex[:12]}@example.org"
    save_profile(did, ProfileData(name="Reader", affiliation="Lab", email=address))
    if verified:
        mark_email_verified(did, issue_verification_token(did, address))
    return did, address


class Paper:
    """A paper that can be listed, built through the submissions API."""

    def __init__(
        self, *, categories, term: Optional[str] = None, status: str = "preprint"
    ) -> None:
        self.tag = uuid.uuid4().hex
        self.term = term or self.tag
        self.key = SigningKey.generate()
        self.did = did_key_from_signing_key(self.key)
        self.categories = list(categories)
        self.title = f"Digest paper {self.term}"
        self.genesis = self._sign(
            "paper.genesis",
            {"seed": self.tag, "title": self.title, "categories": self.categories},
        )
        save_paper(
            paper_cid=self.genesis["id"],
            categories=tuple(self.categories),
            licence="CC-BY-4.0",
            status=status,
        )
        self.short_id = derive_short_id(self.genesis["id"])
        self.cid = self.genesis["id"]
        self.versions: list[str] = []

    def _sign(self, record_type: str, body: dict, prev: Optional[str] = None) -> dict:
        return sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.key,
        )

    def add_version(self) -> str:
        n = len(self.versions) + 1
        prev = self.versions[-1] if self.versions else self.cid
        record = self._sign(
            "paper.version",
            {"paper": self.cid, "n": n, "title": self.title, "abstract": f"v{n}"},
            prev=prev,
        )
        save_version(
            version_cid=record["id"],
            paper_cid=self.cid,
            n=n,
            title=self.title,
            abstract=f"Abstract of {self.term}, version {n}.",
            manifest_cid="bafkreimanifest",
            licence="CC-BY-4.0",
            prev_cid=prev,
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
        )
        self.versions.append(record["id"])
        return record["id"]

    def list_at(self, at: datetime) -> "Paper":
        version = self.add_version()
        for state in _TO_LISTED:
            transition_version(version, state)
        transition_version(version, "listed", at=at)
        return self


def emails_to(address: str) -> list[dict]:
    return [entry for entry in get_outbox() if entry["to"] == address]


def only_email(address: str) -> dict:
    sent = emails_to(address)
    assert len(sent) == 1, f"expected one digest for {address}, got {len(sent)}"
    return sent[0]


def state_of(did: str) -> Optional[datetime]:
    with db.SessionLocal() as session:
        row = session.get(DigestState, did)
        return None if row is None else row.sent_through


# --------------------------------------------------------------------------- #
# What the email lists
# --------------------------------------------------------------------------- #


def test_digest_lists_new_papers_in_followed_categories():
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    paper = Paper(categories=[category]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    email = only_email(address)
    assert email["kind"] == digest.DIGEST_KIND
    assert email["did"] == did
    assert email["subject"] == "[Scholium] Your daily digest: 1 new paper"
    assert paper.title in email["body"]
    assert f"/p/{paper.short_id}" in email["body"]
    assert f"following {category}" in email["body"]


def test_digest_omits_papers_outside_the_readers_categories():
    did, address = reader()
    followed, other = _category(), _category()
    follows.follow_category(did, followed)
    mine = Paper(categories=[followed]).list_at(_ago(2))
    theirs = Paper(categories=[other]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    body = only_email(address)["body"]
    assert mine.title in body
    assert theirs.title not in body


def test_digest_lists_papers_a_saved_search_finds():
    did, address = reader()
    term = _term()
    follows.save_search(did, {"q": term})
    hit = Paper(categories=[_category()], term=term).list_at(_ago(2))
    miss = Paper(categories=[_category()]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    body = only_email(address)["body"]
    assert hit.title in body
    assert miss.title not in body
    assert f'saved search: "{term}"' in body


def test_a_saved_search_without_q_is_a_filter_over_the_new_papers():
    did, address = reader()
    category = _category()
    follows.save_search(did, {"category": [category], "status": ["preprint"]})
    hit = Paper(categories=[category]).list_at(_ago(2))
    wrong_status = Paper(categories=[category], status="reviewed").list_at(_ago(2))
    wrong_category = Paper(categories=[_category()]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    body = only_email(address)["body"]
    assert hit.title in body
    assert wrong_status.title not in body
    assert wrong_category.title not in body


def test_a_saved_searchs_other_filters_narrow_the_digest():
    did, address = reader()
    category, term = _category(), _term()
    # Filters a paper listed two hours ago cannot satisfy.
    follows.save_search(did, {"q": term, "has_code": True})
    follows.save_search(did, {"category": [category], "to": "2000-01-01"})
    follows.save_search(did, {"category": [category], "has_code": True})
    Paper(categories=[category], term=term).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    assert emails_to(address) == []


def test_a_paper_matching_a_follow_and_a_saved_search_is_listed_once_with_both_reasons():
    did, address = reader()
    category, term = _category(), _term()
    follows.follow_category(did, category)
    follows.save_search(did, {"q": term})
    paper = Paper(categories=[category], term=term).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    email = only_email(address)
    assert email["subject"].endswith("1 new paper")
    assert email["body"].count(paper.title) == 1
    assert f"following {category}" in email["body"]
    assert f'saved search: "{term}"' in email["body"]


def test_digest_lists_newest_first_and_counts_the_papers():
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    older = Paper(categories=[category]).list_at(_ago(5))
    newest = Paper(categories=[category]).list_at(_ago(1))
    middle = Paper(categories=[category]).list_at(_ago(3))

    digest.run_daily_digest(now=_now())

    email = only_email(address)
    body = email["body"]
    assert email["subject"] == "[Scholium] Your daily digest: 3 new papers"
    assert body.index(newest.title) < body.index(middle.title) < body.index(older.title)


def test_a_long_digest_is_capped_and_counts_the_rest(monkeypatch):
    monkeypatch.setattr(digest, "MAX_PAPERS_PER_EMAIL", 2)
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    papers = [Paper(categories=[category]).list_at(_ago(h)) for h in (1, 2, 3)]

    digest.run_daily_digest(now=_now())

    email = only_email(address)
    assert email["subject"].endswith("3 new papers")
    assert papers[0].title in email["body"] and papers[1].title in email["body"]
    assert papers[2].title not in email["body"]
    assert "and 1 more paper is not shown" in email["body"]


def test_each_reader_gets_only_their_own_matches():
    alice, alice_address = reader()
    bob, bob_address = reader()
    alice_category, bob_category = _category(), _category()
    follows.follow_category(alice, alice_category)
    follows.follow_category(bob, bob_category)
    for_alice = Paper(categories=[alice_category]).list_at(_ago(2))
    for_bob = Paper(categories=[bob_category]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    alice_body = only_email(alice_address)["body"]
    bob_body = only_email(bob_address)["body"]
    assert for_alice.title in alice_body and for_bob.title not in alice_body
    assert for_bob.title in bob_body and for_alice.title not in bob_body


# --------------------------------------------------------------------------- #
# What counts as new
# --------------------------------------------------------------------------- #


def test_papers_listed_before_the_window_or_after_it_are_not_new():
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    now = _now()
    inside = Paper(categories=[category]).list_at(now - timedelta(hours=2))
    too_old = Paper(categories=[category]).list_at(now - timedelta(hours=30))
    too_late = Paper(categories=[category]).list_at(now + timedelta(minutes=5))

    digest.run_daily_digest(now=now)

    body = only_email(address)["body"]
    assert inside.title in body
    assert too_old.title not in body
    assert too_late.title not in body


def test_a_new_version_of_an_older_paper_is_not_a_new_paper():
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    paper = Paper(categories=[category]).list_at(_ago(40))
    second = paper.add_version()
    for state in _TO_LISTED:
        transition_version(second, state)
    transition_version(second, "listed", at=_ago(1))

    digest.run_daily_digest(now=_now())

    assert emails_to(address) == []


def test_a_second_run_does_not_repeat_a_paper():
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    first = Paper(categories=[category]).list_at(_ago(3))
    now = _now()

    digest.run_daily_digest(now=now)
    digest.run_daily_digest(now=now + timedelta(minutes=1))
    assert len(emails_to(address)) == 1

    # The next day's digest carries only what was listed since.
    second = Paper(categories=[category]).list_at(now + timedelta(hours=1))
    digest.run_daily_digest(now=now + timedelta(days=1))

    emails = emails_to(address)
    assert len(emails) == 2
    assert second.title in emails[1]["body"]
    assert first.title not in emails[1]["body"]


def test_a_reader_with_nothing_new_gets_no_email_and_the_window_moves_on():
    did, address = reader()
    follows.follow_category(did, _category())
    now = _now()

    digest.run_daily_digest(now=now)

    assert emails_to(address) == []
    assert state_of(did) == now.replace(tzinfo=None)


def test_a_reader_is_not_sent_papers_from_before_their_own_window():
    """Every reader's window is their own, though one run reads the papers once.

    ``settled`` was last digested an hour ago; ``fresh`` never was, so their
    window reaches back a day.  The paper listed three hours ago is in
    ``fresh``'s window and was in ``settled``'s previous one.
    """
    settled, settled_address = reader()
    fresh, fresh_address = reader()
    category = _category()
    follows.follow_category(settled, category)
    follows.follow_category(fresh, category)
    now = _now()
    paper = Paper(categories=[category]).list_at(now - timedelta(hours=3))
    with db.SessionLocal() as session:
        session.merge(
            DigestState(did=settled, sent_through=(now - timedelta(hours=1)).replace(tzinfo=None))
        )
        session.commit()

    digest.run_daily_digest(now=now)

    assert paper.title in only_email(fresh_address)["body"]
    assert emails_to(settled_address) == []


def test_a_long_gap_never_looks_back_past_the_cap():
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    now = _now()
    ancient = Paper(categories=[category]).list_at(now - timedelta(days=30))
    recent = Paper(categories=[category]).list_at(now - timedelta(days=3))
    with db.SessionLocal() as session:
        session.merge(
            DigestState(did=did, sent_through=(now - timedelta(days=60)).replace(tzinfo=None))
        )
        session.commit()

    digest.run_daily_digest(now=now)

    body = only_email(address)["body"]
    assert recent.title in body
    assert ancient.title not in body


# --------------------------------------------------------------------------- #
# Who is emailed
# --------------------------------------------------------------------------- #


def test_an_unverified_address_is_never_emailed():
    did, address = reader(verified=False)
    category = _category()
    follows.follow_category(did, category)
    Paper(categories=[category]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    assert emails_to(address) == []


def test_an_account_without_a_profile_is_skipped():
    did = _did()
    category = _category()
    follows.follow_category(did, category)
    Paper(categories=[category]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    assert [e for e in get_outbox() if e["did"] == did] == []


def test_verifying_later_does_not_release_a_backlog():
    did, address = reader(verified=False)
    category = _category()
    follows.follow_category(did, category)
    old = Paper(categories=[category]).list_at(_ago(2))
    now = _now()
    digest.run_daily_digest(now=now)

    mark_email_verified(did, issue_verification_token(did, address))
    fresh = Paper(categories=[category]).list_at(now + timedelta(hours=1))
    digest.run_daily_digest(now=now + timedelta(hours=2))

    body = only_email(address)["body"]
    assert fresh.title in body
    assert old.title not in body


def test_digest_recipients_are_accounts_that_follow_or_saved_a_search():
    follower, searcher, neither = _did(), _did(), _did()
    follows.follow_category(follower, _category())
    follows.save_search(searcher, {"q": _term()})

    recipients = digest.digest_recipients()

    assert follower in recipients and searcher in recipients
    assert neither not in recipients


# --------------------------------------------------------------------------- #
# Delivery
# --------------------------------------------------------------------------- #


def test_digest_goes_through_smtp_when_it_is_configured(monkeypatch):
    sent = []
    monkeypatch.setattr(settings, "SMTP_URL", "smtp://mail.example:25")
    monkeypatch.setattr(digest, "send_email", lambda email, url: sent.append((email, url)))
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    paper = Paper(categories=[category]).list_at(_ago(2))

    digest.run_daily_digest(now=_now())

    mine = [(email, url) for email, url in sent if email.to == address]
    assert len(mine) == 1
    email, url = mine[0]
    assert url == "smtp://mail.example:25"
    assert paper.title in email.body
    assert emails_to(address) == []  # delivered, so not parked in the outbox


def test_a_failed_smtp_delivery_keeps_the_window_open_for_the_next_run(monkeypatch):
    def refuse(email, url):
        raise OSError("connection refused")

    monkeypatch.setattr(settings, "SMTP_URL", "smtp://mail.example:25")
    monkeypatch.setattr(digest, "send_email", refuse)
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    paper = Paper(categories=[category]).list_at(_ago(2))
    now = _now()

    run = digest.run_daily_digest(now=now)

    assert run.failed >= 1
    assert state_of(did) is None  # not settled
    (parked,) = emails_to(address)  # kept as a record, flagged as not sent
    assert parked["reason"] == "smtp delivery failed"

    delivered = []
    monkeypatch.setattr(digest, "send_email", lambda email, url: delivered.append(email))
    digest.run_daily_digest(now=now + timedelta(minutes=10))

    (email,) = [e for e in delivered if e.to == address]
    assert paper.title in email.body
    assert state_of(did) == (now + timedelta(minutes=10)).replace(tzinfo=None)


def test_one_readers_failure_does_not_stop_the_others(monkeypatch):
    broken, broken_address = reader()
    healthy, healthy_address = reader()
    category = _category()
    follows.follow_category(broken, category)
    follows.follow_category(healthy, category)
    Paper(categories=[category]).list_at(_ago(2))

    real = digest.compose_digest

    def flaky(did, **kwargs):
        if did == broken:
            raise RuntimeError("boom")
        return real(did, **kwargs)

    monkeypatch.setattr(digest, "compose_digest", flaky)

    digest.run_daily_digest(now=_now())

    assert emails_to(broken_address) == []
    assert len(emails_to(healthy_address)) == 1
    assert state_of(broken) is None


# --------------------------------------------------------------------------- #
# The job
# --------------------------------------------------------------------------- #


def test_next_run_is_the_next_digest_hour():
    hour = digest.DIGEST_HOUR_UTC
    before = datetime(2026, 3, 1, hour - 1, 30)
    at = datetime(2026, 3, 1, hour, 0)
    after = datetime(2026, 3, 1, hour, 0, 1)

    assert digest.next_run_at(before) == datetime(2026, 3, 1, hour)
    assert digest.next_run_at(at) == datetime(2026, 3, 2, hour)
    assert digest.next_run_at(after) == datetime(2026, 3, 2, hour)
    assert digest.next_run_at(datetime(2026, 3, 1, 12, tzinfo=timezone.utc)) == datetime(
        2026, 3, 2, hour
    )


def test_the_digest_kind_is_registered_with_the_job_runner():
    # ``enqueue`` raises ``UnknownJobKind`` for a kind with no handler, so
    # getting an id back proves the plugin registered one.
    job_id = jobs.enqueue(digest.JOB_KIND, {}, run_after=_now() + timedelta(days=1))
    assert isinstance(job_id, int)


def test_the_job_sends_the_digests_and_queues_tomorrows_run():
    did, address = reader()
    category = _category()
    follows.follow_category(did, category)
    paper = Paper(categories=[category]).list_at(_ago(2))

    jobs.enqueue(digest.JOB_KIND, {})  # eager: runs inline

    assert paper.title in only_email(address)["body"]
    (queued,) = _queued_digest_jobs()
    assert queued.run_after == digest.next_run_at()
    assert queued.run_after > datetime.now(timezone.utc).replace(tzinfo=None)


def test_a_reader_who_follows_and_saves_through_the_api_gets_the_digest(client):
    """The whole feature as a reader meets it: the routes, then the job."""
    from app.security import issue_access_token

    did, address = reader()
    headers = {"Authorization": f"Bearer {issue_access_token(did, 1)}"}
    category, term = _category(), _term()

    assert client.put(f"/v1/me/follows/{category}", headers=headers).status_code == 204
    saved = client.post("/v1/me/saved-searches", json={"query": {"q": term}}, headers=headers)
    assert saved.status_code == 201, saved.text
    followed = Paper(categories=[category]).list_at(_ago(2))
    found = Paper(categories=[_category()], term=term).list_at(_ago(2))
    ignored = Paper(categories=[_category()]).list_at(_ago(2))

    jobs.enqueue(digest.JOB_KIND, {})  # eager: the job runs inline

    email = only_email(address)
    assert email["subject"] == "[Scholium] Your daily digest: 2 new papers"
    assert followed.title in email["body"]
    assert found.title in email["body"]
    assert ignored.title not in email["body"]


def test_running_the_job_again_does_not_double_the_chain():
    digest.run_daily_digest_job()
    digest.run_daily_digest_job()
    digest.run_daily_digest_job()

    assert len(_queued_digest_jobs()) == 1


def test_a_job_with_an_undeliverable_digest_raises_but_still_queues_tomorrow(monkeypatch):
    monkeypatch.setattr(settings, "SMTP_URL", "smtp://mail.example:25")
    monkeypatch.setattr(
        digest, "send_email", lambda email, url: (_ for _ in ()).throw(OSError("down"))
    )
    did, _ = reader()
    category = _category()
    follows.follow_category(did, category)
    Paper(categories=[category]).list_at(_ago(2))

    with pytest.raises(digest.DigestDeliveryError):
        digest.run_daily_digest_job()
    with pytest.raises(digest.DigestDeliveryError):  # the runner's retry
        digest.run_daily_digest_job()

    assert len(_queued_digest_jobs()) == 1


def test_startup_queues_the_first_run_when_jobs_use_the_worker(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 0)
    started = []
    monkeypatch.setattr(jobs, "start_worker", lambda: started.append(True))

    follows.on_startup()
    follows.on_startup()  # another app assembled: still one

    (queued,) = _queued_digest_jobs()
    assert queued.run_after == digest.next_run_at()
    assert started == []  # the lifespan owns the worker, not this hook


def test_startup_queues_nothing_in_eager_mode(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 1)

    follows.on_startup()

    assert _queued_digest_jobs() == []


def test_a_startup_that_cannot_queue_the_job_does_not_stop_the_app(monkeypatch):
    monkeypatch.setattr(settings, "JOBS_EAGER", 0)

    def broken(now=None):
        raise RuntimeError("database is down")

    monkeypatch.setattr(follows, "schedule_digest", broken)

    follows.on_startup()  # must not raise
