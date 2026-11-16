"""The daily email digest of new papers (plugin: follows, feature 181).

Once a day a background job emails each reader the papers that were listed
since their last digest and match what they follow:

* a paper filed under a category they **follow** (feature 179), or
* a paper one of their **saved searches** (feature 180) finds.

Each paper is listed once, with the reasons it matched, newest first.  A reader
with nothing new gets no email.

What "new" means
----------------

A paper is new in a window ``(since, until]`` when the instant it *first*
appeared in the catalog -- the earliest ``listed_at`` among its listed versions,
the catalog's ``newest`` sort key -- falls inside it.  A second version of an
older paper is not a new paper.  ``until`` is fixed when a run starts, so a paper
listed while the run is under way falls in the next window rather than being
missed or sent twice.

``since`` is where that reader's last digest settled (``digest_state``); a
reader never digested before gets the last :data:`DIGEST_INTERVAL`, and no
window reaches back further than :data:`MAX_LOOKBACK`.  The window only advances
once the reader's email was handed over (or there was nothing to send), so a
delivery failure is retried by the next run instead of dropping those papers,
and a job the runner retries never repeats an email it already sent.

Who is emailed
--------------

Every account that follows a category or saved a search *and* holds a
**verified** profile address (feature 178).  A digest recurs every day, so it is
only ever sent to an address its owner has proven; otherwise anyone could
subscribe a stranger by typing their address into a profile.  Accounts without
one are skipped, and their window advances so that verifying later does not
release a backlog.

How it runs
-----------

``follows.digest`` is a job kind registered with :mod:`app.jobs`.  Its handler
first queues the next run for tomorrow (:data:`DIGEST_HOUR_UTC`) -- unless one is
already waiting -- and then sends the digests, so the chain survives a crash
mid-run and a retry never doubles it.  The plugin's startup hook queues the
first run when jobs run on the background worker (``JOBS_EAGER=0``); in eager
mode nothing would ever pick a deferred job up, so there it is only run when
asked: ``jobs.enqueue(JOB_KIND)`` or :func:`run_daily_digest`.

Delivery follows the notifications plugin's rule: through SMTP when ``SMTP_URL``
is set, otherwise (and, as a record, when SMTP fails) to the outbox log.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Optional
from urllib.parse import quote

from sqlalchemy import inspect, select
from sqlalchemy.exc import OperationalError, ProgrammingError

from app import db, jobs
from app.modules.catalog import listing as catalog
from app.modules.notifications import Email, log_to_outbox, send_email
from app.modules.notifications.emailer import DEFAULT_FROM
from app.modules.profiles import email_verified, read_profile
from app.modules.search.query import search_versions, version_has_code
from app.settings import settings

from .models import DigestState, Follow, SavedSearch, ensure_tables
from .service import followed_categories, saved_searches

__all__ = [
    "DIGEST_HOUR_UTC",
    "DIGEST_INTERVAL",
    "DIGEST_KIND",
    "Digest",
    "DigestDeliveryError",
    "DigestItem",
    "DigestRun",
    "JOB_KIND",
    "MAX_LOOKBACK",
    "MAX_PAPERS_PER_EMAIL",
    "compose_digest",
    "describe_query",
    "digest_recipients",
    "next_run_at",
    "render_digest",
    "run_daily_digest",
    "run_daily_digest_job",
    "schedule_digest",
]

logger = logging.getLogger(__name__)

#: The job kind the runner registers the digest handler under.
JOB_KIND = "follows.digest"

#: The ``kind`` the digest's email carries in the outbox.
DIGEST_KIND = "digest.daily"

#: How often the digest runs, and how far back a reader's first one looks.
DIGEST_INTERVAL = timedelta(days=1)

#: The hour (UTC) the job is scheduled for each day.
DIGEST_HOUR_UTC = 6

#: No window reaches back further than this, so a long outage (or a long
#: delivery failure) cannot produce an enormous email.
MAX_LOOKBACK = timedelta(days=7)

#: Papers listed in one email; the rest are counted in a closing line.
MAX_PAPERS_PER_EMAIL = 50

#: Upper bound on the hits read back from one saved search's re-run.  The run
#: is already narrowed to the window's days, so this is a safety net only.
_SEARCH_SCAN_LIMIT = 10_000

_SENT = "sent"
_EMPTY = "empty"
_NO_ADDRESS = "no_address"
_FAILED = "failed"


class DigestDeliveryError(RuntimeError):
    """At least one reader's digest could not be delivered; the job retries."""


@dataclass(frozen=True)
class DigestItem:
    """One new paper in a reader's digest, and why it is there."""

    paper_cid: str
    short_id: str
    title: str
    categories: tuple[str, ...]
    #: When the paper first appeared in the catalog (naive UTC).
    listed_at: datetime
    #: ``following cs.AI``, ``saved search: "pulsar timing"`` ... in match order.
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class Digest:
    """The new papers matching one reader's follows and saved searches."""

    did: str
    #: The window the papers were first listed in: ``since < listed_at <= until``.
    since: datetime
    until: datetime
    items: tuple[DigestItem, ...]


@dataclass
class DigestRun:
    """What one pass of the job did, per reader."""

    #: Emails handed to SMTP (or, with no SMTP configured, to the outbox).
    sent: int = 0
    #: Readers with nothing new.
    empty: int = 0
    #: Readers skipped for lack of a verified profile address.
    skipped: int = 0
    #: Readers whose email could not be delivered or composed; retried next run.
    failed: int = 0


# --------------------------------------------------------------------------- #
# Time
# --------------------------------------------------------------------------- #


def _naive_utc(value: datetime) -> datetime:
    """``value`` as the naive UTC the tables store."""
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _utcnow() -> datetime:
    return _naive_utc(datetime.now(timezone.utc))


def next_run_at(now: Optional[datetime] = None) -> datetime:
    """The next :data:`DIGEST_HOUR_UTC` strictly after ``now`` (naive UTC)."""
    moment = _naive_utc(now) if now is not None else _utcnow()
    today = moment.replace(hour=DIGEST_HOUR_UTC, minute=0, second=0, microsecond=0)
    return today if today > moment else today + timedelta(days=1)


# --------------------------------------------------------------------------- #
# Which papers are new, and who they matter to
# --------------------------------------------------------------------------- #


def _new_entries(since: datetime, until: datetime) -> list[catalog.CatalogEntry]:
    """Every listed paper first listed in ``(since, until]``, newest first.

    Walks the public catalog's ``newest`` sort -- first-listed, newest first --
    and stops at the first paper listed on or before ``since``, so a day's
    digest reads a day's papers and not the whole catalog's pages.
    """
    found: list[catalog.CatalogEntry] = []
    cursor: Optional[str] = None
    while True:
        page = catalog.list_papers(
            tab="latest", sort="newest", cursor=cursor, limit=catalog.MAX_LIMIT
        )
        for entry in page.entries:
            listed = entry.listed_at
            if listed is None or _naive_utc(listed) <= since:
                return found
            if _naive_utc(listed) <= until:
                found.append(entry)
        if page.next_cursor is None:
            return found
        cursor = page.next_cursor


def _paper_categories(entry: catalog.CatalogEntry) -> list[str]:
    raw = entry.paper.categories
    if not isinstance(raw, (list, tuple)):
        return []
    return [item for item in raw if isinstance(item, str)]


def _quote_term(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return '"' + (text if len(text) <= limit else text[: limit - 1] + "…") + '"'


def describe_query(query: Mapping[str, Any]) -> str:
    """A saved search's filters as one line for an email.

    ``"pulsar timing" in cs.CR, cs.LG, status reviewed, with code, from
    2026-03-02, to 2026-04-01`` -- only the filters the search carries.
    """
    parts: list[str] = []
    q = query.get("q")
    categories = query.get("category") or []
    statuses = query.get("status") or []
    if isinstance(q, str) and q.strip():
        term = _quote_term(q)
        parts.append(f"{term} in {', '.join(categories)}" if categories else term)
    elif categories:
        parts.append("in " + ", ".join(categories))
    if statuses:
        parts.append("status " + ", ".join(statuses))
    if query.get("has_code") is True:
        parts.append("with code")
    elif query.get("has_code") is False:
        parts.append("without code")
    if query.get("from"):
        parts.append(f"from {query['from']}")
    if query.get("to"):
        parts.append(f"to {query['to']}")
    return ", ".join(str(part) for part in parts) or "all papers"


def _parse_date(value: Any) -> Optional[date]:
    if value in (None, ""):
        return None
    return date.fromisoformat(str(value))


def _filters_match(
    entry: catalog.CatalogEntry,
    *,
    categories: tuple[str, ...],
    statuses: tuple[str, ...],
    has_code: Optional[bool],
    date_from: Optional[date],
    date_to: Optional[date],
) -> bool:
    """Whether a paper passes a saved search's filters (the search's rules).

    Used for a search that names no ``q``: the search endpoint needs words to
    match, so such a search is a plain filter over the new papers.  Categories
    and statuses are "any of", status is case-insensitive, the date range is
    inclusive on the paper's first listing, and ``has_code`` is read from the
    manifest of the version the catalog shows.
    """
    if categories and not set(categories) & set(_paper_categories(entry)):
        return False
    if statuses and (entry.paper.status or "").lower() not in {
        status.lower() for status in statuses
    }:
        return False
    if date_from is not None or date_to is not None:
        if entry.listed_at is None:
            return False
        listed_on = _naive_utc(entry.listed_at).date()
        if date_from is not None and listed_on < date_from:
            return False
        if date_to is not None and listed_on > date_to:
            return False
    if has_code is not None and version_has_code(entry.version.manifest_cid) is not has_code:
        return False
    return True


def _search_matches(
    query: object, since: datetime, window: list[catalog.CatalogEntry]
) -> set[str]:
    """The paper cids in ``window`` that a saved search finds."""
    if not isinstance(query, dict):
        return set()
    try:
        date_from = _parse_date(query.get("from"))
        date_to = _parse_date(query.get("to"))
    except ValueError:
        logger.warning("skipping a saved search with an unreadable date: %r", query)
        return set()
    categories = tuple(str(c) for c in query.get("category") or ())
    statuses = tuple(str(s) for s in query.get("status") or ())
    has_code = query.get("has_code")
    if not isinstance(has_code, bool):
        has_code = None

    q = query.get("q")
    if isinstance(q, str) and q.strip():
        # Re-run the search as the search endpoint would.  Every version of a
        # new paper was listed on or after the paper's first listing, so the
        # window's first day is a safe lower bound that keeps the run small.
        floor = since.date()
        result = search_versions(
            q,
            limit=_SEARCH_SCAN_LIMIT,
            categories=categories,
            statuses=statuses,
            has_code=has_code,
            date_from=max(date_from, floor) if date_from else floor,
            date_to=date_to,
        )
        wanted = {entry.paper.paper_cid for entry in window}
        return {hit.paper_cid for hit in result.hits if hit.paper_cid in wanted}

    return {
        entry.paper.paper_cid
        for entry in window
        if _filters_match(
            entry,
            categories=categories,
            statuses=statuses,
            has_code=has_code,
            date_from=date_from,
            date_to=date_to,
        )
    }


def compose_digest(
    did: str,
    *,
    since: datetime,
    until: datetime,
    entries: Optional[list[catalog.CatalogEntry]] = None,
) -> Digest:
    """The papers first listed in ``(since, until]`` that ``did`` follows or saved.

    ``entries`` may carry the window's new papers when the caller already read
    them (:func:`run_daily_digest` reads them once for every reader); papers
    outside the window are ignored either way.
    """
    since, until = _naive_utc(since), _naive_utc(until)
    if entries is None:
        entries = _new_entries(since, until)
    window = [
        entry
        for entry in entries
        if entry.listed_at is not None and since < _naive_utc(entry.listed_at) <= until
    ]

    reasons: dict[str, list[str]] = {}
    followed = followed_categories(did)
    for entry in window:
        on_paper = set(_paper_categories(entry))
        for category in followed:
            if category in on_paper:
                reasons.setdefault(entry.paper.paper_cid, []).append(f"following {category}")
    for search in saved_searches(did):
        label = f"saved search: {describe_query(search.query)}"
        for cid in _search_matches(search.query, since, window):
            reasons.setdefault(cid, []).append(label)

    items = [
        DigestItem(
            paper_cid=entry.paper.paper_cid,
            short_id=entry.paper.short_id,
            title=entry.version.title,
            categories=tuple(_paper_categories(entry)),
            listed_at=_naive_utc(entry.listed_at),
            reasons=tuple(dict.fromkeys(reasons[entry.paper.paper_cid])),
        )
        for entry in window
        if entry.paper.paper_cid in reasons
    ]
    items.sort(key=lambda item: (item.listed_at, item.paper_cid), reverse=True)
    return Digest(did=did, since=since, until=until, items=tuple(items))


# --------------------------------------------------------------------------- #
# The email
# --------------------------------------------------------------------------- #


def _web_base() -> str:
    """The browser origin links point at: the first ``WEB_ORIGINS`` entry."""
    origins = settings.web_origins
    if origins:
        return origins[0].strip().rstrip("/")
    return (settings.NEXT_PUBLIC_API_URL or "").strip().rstrip("/")


def render_digest(digest: Digest, *, base_url: Optional[str] = None) -> tuple[str, str]:
    """``(subject, body)`` for a digest with at least one paper."""
    base = (base_url if base_url is not None else _web_base()).strip().rstrip("/")
    total = len(digest.items)
    noun = "paper" if total == 1 else "papers"
    subject = f"[Scholium] Your daily digest: {total} new {noun}"

    lines = [
        f"{total} new {noun} listed since {digest.since:%Y-%m-%d %H:%M} UTC "
        "match what you follow on Scholium.",
        "",
    ]
    for number, item in enumerate(digest.items[:MAX_PAPERS_PER_EMAIL], start=1):
        title = " ".join(item.title.split()) or item.short_id
        lines.append(f"{number}. {title}")
        lines.append(f"   {base}/p/{quote(item.short_id, safe=':')}")
        if item.categories:
            lines.append(f"   Categories: {', '.join(item.categories)}")
        lines.append(f"   Matched: {'; '.join(item.reasons)}")
        lines.append("")
    hidden = total - MAX_PAPERS_PER_EMAIL
    if hidden > 0:
        more = "paper is" if hidden == 1 else "papers are"
        lines.extend([f"... and {hidden} more {more} not shown here.", ""])
    lines.extend(
        [
            "--",
            "You get this digest because you follow categories or have saved "
            "searches on Scholium.",
        ]
    )
    return subject, "\n".join(lines) + "\n"


def _deliver(did: str, address: str, subject: str, body: str) -> bool:
    """Hand the email over; ``False`` when SMTP is configured but failed.

    Mirrors ``notify``: SMTP when ``SMTP_URL`` is set, the outbox log when it
    is not.  A failed SMTP delivery is also logged to the outbox as a record,
    but it is reported so the reader's window stays open for the next run.
    """
    email = Email(
        to=address, from_addr=DEFAULT_FROM, subject=subject, body=body, did=did, kind=DIGEST_KIND
    )
    smtp_url = (settings.SMTP_URL or "").strip()
    if not smtp_url:
        log_to_outbox(email)
        return True
    try:
        send_email(email, smtp_url)
    except Exception:
        logger.exception("SMTP delivery of the daily digest to %s failed", did)
        log_to_outbox(email, reason="smtp delivery failed")
        return False
    return True


# --------------------------------------------------------------------------- #
# Running the digest
# --------------------------------------------------------------------------- #


def digest_recipients() -> list[str]:
    """Every account that follows a category or saved a search, sorted."""
    ensure_tables()
    with db.SessionLocal() as session:
        dids = set(session.execute(select(Follow.did).distinct()).scalars())
        dids.update(session.execute(select(SavedSearch.did).distinct()).scalars())
    return sorted(dids)


def _address(did: str) -> Optional[str]:
    """``did``'s verified profile address, or ``None`` when there is none."""
    try:
        profile = read_profile(did)
        address = (profile.email or "").strip() if profile is not None else ""
        return address if address and email_verified(did) else None
    except Exception:
        logger.exception("could not read the profile of %s for the daily digest", did)
        return None


def _load_states(dids: list[str]) -> dict[str, datetime]:
    wanted = set(dids)
    with db.SessionLocal() as session:
        rows = session.execute(select(DigestState.did, DigestState.sent_through))
        return {did: sent for did, sent in rows if did in wanted}


def _settle(did: str, until: datetime) -> None:
    """Record that ``did``'s digest is settled through ``until``."""
    with db.SessionLocal() as session:
        session.merge(DigestState(did=did, sent_through=until))
        session.commit()


def _digest_one(
    did: str,
    since: datetime,
    until: datetime,
    entries: list[catalog.CatalogEntry],
) -> str:
    address = _address(did)
    if address is None:
        return _NO_ADDRESS
    digest = compose_digest(did, since=since, until=until, entries=entries)
    if not digest.items:
        return _EMPTY
    subject, body = render_digest(digest)
    return _SENT if _deliver(did, address, subject, body) else _FAILED


def run_daily_digest(now: Optional[datetime] = None) -> DigestRun:
    """Send every reader the digest of what was listed since their last one.

    ``now`` (default: the current time) is the end of every window.  A reader
    whose digest cannot be delivered is counted in ``failed`` and keeps their
    window; everyone else's is settled through ``now``.  One reader's failure
    never stops the rest.
    """
    until = _naive_utc(now) if now is not None else _utcnow()
    run = DigestRun()
    recipients = digest_recipients()
    if not recipients:
        return run

    states = _load_states(recipients)
    floor = until - MAX_LOOKBACK
    since_of = {
        did: max(states.get(did, until - DIGEST_INTERVAL), floor) for did in recipients
    }
    # Read the new papers once, for the reader with the oldest window.
    entries = _new_entries(min(since_of.values()), until)

    for did in recipients:
        since = since_of[did]
        if since >= until:
            # Already settled through (or past) this instant: nothing to do.
            run.empty += 1
            continue
        try:
            outcome = _digest_one(did, since, until, entries)
        except Exception:
            logger.exception("could not compose the daily digest for %s", did)
            outcome = _FAILED
        if outcome == _FAILED:
            run.failed += 1
            continue
        _settle(did, until)
        if outcome == _SENT:
            run.sent += 1
        elif outcome == _EMPTY:
            run.empty += 1
        else:
            run.skipped += 1
    return run


# --------------------------------------------------------------------------- #
# The job
# --------------------------------------------------------------------------- #


def _digest_job_queued() -> bool:
    """Whether a ``follows.digest`` job is already waiting to run."""
    try:
        with db.SessionLocal() as session:
            waiting = session.execute(
                select(jobs.Job.id)
                .where(jobs.Job.kind == JOB_KIND, jobs.Job.status == jobs.STATUS_QUEUED)
                .limit(1)
            ).first()
    except (OperationalError, ProgrammingError):
        # No ``jobs`` table yet (the app creates its tables after the plugins
        # load); nothing can be waiting in it.
        return False
    return waiting is not None


def _persist_job(run_after: datetime) -> int:
    """Queue one ``follows.digest`` job for ``run_after``; return its id.

    Written directly rather than through :func:`app.jobs.enqueue`: ``enqueue``
    also starts the worker thread, which the application's lifespan owns, and a
    job due hours from now does not need waking.  The worker finds it by its
    poll.
    """
    try:
        jobs.Job.__table__.create(bind=db.engine, checkfirst=True)
    except (OperationalError, ProgrammingError):
        # ``checkfirst`` is not atomic: another process may have created it.
        if not inspect(db.engine).has_table(jobs.Job.__tablename__):
            raise
    with db.SessionLocal() as session:
        job = jobs.Job(
            kind=JOB_KIND,
            payload={},
            status=jobs.STATUS_QUEUED,
            run_after=run_after,
            attempts=0,
        )
        session.add(job)
        session.commit()
        return job.id


def schedule_digest(now: Optional[datetime] = None) -> Optional[int]:
    """Queue the next daily digest unless one is already waiting.

    Returns the new job's id, or ``None`` when a ``follows.digest`` job is
    already queued.  The job is due at the next :data:`DIGEST_HOUR_UTC`.
    """
    if _digest_job_queued():
        return None
    return _persist_job(next_run_at(now))


def run_daily_digest_job(payload: Any = None) -> None:
    """The ``follows.digest`` job handler.

    Queues tomorrow's run first -- so a crash or a failure below cannot end the
    daily chain, and the runner's retry of this job finds it already queued --
    then sends the digests.  Raises :class:`DigestDeliveryError` when a reader's
    digest could not be delivered, which makes the runner retry the job; readers
    already settled are not emailed again.
    """
    schedule_digest()
    run = run_daily_digest()
    logger.info(
        "daily digest: %s sent, %s empty, %s skipped, %s failed",
        run.sent,
        run.empty,
        run.skipped,
        run.failed,
    )
    if run.failed:
        raise DigestDeliveryError(f"{run.failed} daily digest(s) could not be delivered")


# Register at import time so ``jobs.enqueue`` accepts the kind and a worker
# claims it; the module loader imports every plugin package.
jobs.register(JOB_KIND, run_daily_digest_job)
