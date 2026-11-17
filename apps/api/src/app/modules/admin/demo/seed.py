"""``seed-demo``: act as the demo cast, against this node's own API.

Nothing is written to the node's tables directly except the one thing HTTP
cannot do -- appointing the moderator and the reviewers, which is what
``set-tier`` is for.  Everything else is what the people would do themselves:
sign in with their key, save a profile, upload a manuscript, and *sign* the
records -- endorsements, the manifest, the paper genesis and version, consents,
the moderator's decision, review commits and reveals -- here, with the keys in
``.demo-keys.json``, then submit them to ``POST /v1/records`` (or the review
endpoints) like any client.  The node validates, verifies and stores them exactly
as it would from a browser.

The app runs in this process, behind a ``TestClient``, so no server has to be
up.  For the duration of the run four settings are pinned, and put back after:

* the write throttle is off -- it protects the public API from strangers, and
  this is the operator acting on their own node;
* ``SMTP_URL`` is empty -- saving a profile sends a verification mail, which
  goes to an in-process outbox that dies with the command instead of out;
* ``AI_PROVIDER`` is ``fake`` -- no hosted-model calls (or spend) for fictional
  papers;
* ``JOBS_EAGER`` is on -- the scan and AI pre-review jobs finish in this process
  before it exits, rather than waiting for a worker that is not running.

Running it again is safe.  Keys, timestamps, manuscripts and review secrets are
all derived from the keys file, so every record is byte-identical to the first
run's and the node answers each with ``409`` duplicate, which counts as "already
there".  Delete ``.demo-keys.json`` to get a new cast instead.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from scholium_record_core import derive_short_id, did_key_from_signing_key, encode_signature, sign_record
from sqlalchemy.engine import make_url

from app import jobs
from app.modules.ingest import DUPLICATE_RECORD
from app.modules.ledger import node_signing_key
from app.modules.reviews import REVIEW_ALREADY_COMMITTED, REVIEW_ALREADY_REVEALED, commitment_digest
from app.modules.submissions import get_version
from app.modules.submissions.state import LISTED, MODERATION
from app.security import decode_access_token
from app.settings import settings

from ..service import set_tier
from .cast import LICENCE, PAPERS, PEOPLE, RUBRIC, TIER_FOR_ROLE, DemoPaper, DemoReview, Person, people_by_slug
from .keys import DemoAccount, DemoKeys
from .manuscript import build_pdf

__all__ = ["SeedError", "SeedResult", "SeededAccount", "SeededPaper", "seed_demo"]

#: Seconds after a paper's submission that each of its records is dated.
_MANIFEST, _GENESIS, _VERSION, _CONSENT = 0, 1, 2, 10
_DECISION, _REVIEW_COMMIT, _REVIEW_REVEAL = 3_600, 7_200, 10_800
#: Endorsements predate every paper.
_ENDORSEMENT_DAYS_AGO = 40

#: Clause cited when the moderator lists a paper: the scope clause.
_LISTING_CLAUSE = "MOD-01"

_JUSTIFICATION = {5: "excellent", 4: "good", 3: "adequate, with gaps", 2: "weak", 1: "poor"}

#: Settings pinned while seeding (see the module docstring).
_PINNED = {"RATE_LIMIT_ENABLED": 0, "SMTP_URL": "", "AI_PROVIDER": "fake", "JOBS_EAGER": 1}


class SeedError(RuntimeError):
    """The node refused a step, or the demo data could not be put in place."""


@dataclass(frozen=True)
class SeededAccount:
    slug: str
    name: str
    role: str
    tier: int
    did: str


@dataclass
class SeededPaper:
    slug: str
    title: str
    short_id: str
    paper_cid: str
    version_cid: str
    #: The version's state on the node: ``listed``, or ``moderation`` for the one left in the queue.
    state: str
    #: ``False`` when the node already had this paper from an earlier run.
    created: bool
    reviews_revealed: int = 0
    reviews_sealed: int = 0
    ai_reviewed: bool = False


@dataclass
class SeedResult:
    database: str
    keys_path: Path
    keys_created: bool
    accounts: list[SeededAccount] = field(default_factory=list)
    papers: list[SeededPaper] = field(default_factory=list)
    #: The node signing key this run had to create (``None`` when the node had one).
    node_key_created: Optional[Path] = None
    #: Warnings and errors the node logged while seeding (background jobs mostly),
    #: as ``headline -> how often``.  Empty with ``verbose``: they were printed as they happened.
    node_log: dict[str, int] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def seed_demo(
    keys_path: Path | str,
    *,
    log: Callable[[str], None] = lambda _message: None,
    verbose: bool = False,
) -> SeedResult:
    """Load the demo cast into the node ``DATABASE_URL`` names; return what is there.

    ``log`` receives progress lines.  What the *node* logs meanwhile (a background
    job that fails and is retried, say) is collected into ``SeedResult.node_log``
    rather than printed, unless ``verbose``, so a run that worked reads as one.

    Raises:
        SeedError: this is a production node, or the node refused a step.
        DemoKeysError: the keys file exists but cannot be used.
    """
    if settings.SCHOLIUM_ENV == "production":
        raise SeedError("refusing to load demo data into a production node (SCHOLIUM_ENV=production)")

    keys = DemoKeys.load_or_create(keys_path)
    for person in PEOPLE:
        keys.account(person.slug, name=person.name, role=person.role)
    # Before the node sees any of these accounts: whatever happens next, the
    # keys of everyone it may have stored are on disk.
    keys.save()
    log(f"keys: {keys.path.resolve()} ({'new cast' if keys.created else 'same cast as before'})")

    database = make_url(settings.DATABASE_URL).render_as_string(hide_password=True)
    log(f"node database: {database}")

    result = SeedResult(database=database, keys_path=keys.path.resolve(), keys_created=keys.created)
    with _pinned_settings(log), _collected_node_log(result, verbose, log):
        from app.main import create_app  # builds an app at import; keep it inside the pinned settings

        result.node_key_created = _ensure_node_key(log)
        with TestClient(create_app()) as http:
            _Seeder(http, keys, log, result).run()
    return result


def _ensure_node_key(log: Callable[[str], None]) -> Optional[Path]:
    """Give the node a signing key when it has none; return the path created, if any.

    A demo node is disposable, so a *missing* key is made here rather than
    worked around (without one the node cannot sign the renditions and AI
    pre-review records it adds to a paper's history).  An existing file is the
    operator's: never replaced, never "fixed" when it cannot be read -- only
    noted, for the operator to resolve with ``init-node``.
    """
    from ..node_key import NodeKeyExistsError, init_node_key

    if node_signing_key() is not None:
        return None
    path = Path(settings.NODE_KEY_PATH).expanduser()
    if path.exists():
        log(
            f"note: no usable node signing key at NODE_KEY_PATH ({path}): the node cannot "
            "sign renditions or AI pre-review records, so the papers get neither"
        )
        return None
    try:
        made = init_node_key(path)
    except NodeKeyExistsError:  # appeared between the look and the write; the node can use it
        log(f"note: a node signing key appeared at {path} while seeding; using it")
        return path
    log(f"created the node signing key at {made.path}; the node signs as {made.did}")
    return made.path


@contextlib.contextmanager
def _pinned_settings(log: Callable[[str], None]) -> Iterator[None]:
    saved: dict[str, Any] = {}
    for name, value in _PINNED.items():
        current = getattr(settings, name)
        if current == value:
            continue
        saved[name] = current
        setattr(settings, name, value)
        if name in ("AI_PROVIDER", "SMTP_URL"):
            log(f"note: {name} is {current!r} here; the demo run uses {value!r} instead")
    try:
        yield
    finally:
        for name, value in saved.items():
            setattr(settings, name, value)


_CID = re.compile(r"\bbafy[a-z0-9]+")


class _NodeLogCollector(logging.Handler):
    """Counts the warnings and errors the node logs, by headline (first line, cids elided)."""

    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.headlines: Counter[str] = Counter()

    def emit(self, record: logging.LogRecord) -> None:
        lines = record.getMessage().strip().splitlines() or [record.name]
        self.headlines[_CID.sub("<cid>", lines[0])[:160]] += 1


@contextlib.contextmanager
def _collected_node_log(result: SeedResult, verbose: bool, log: Callable[[str], None]) -> Iterator[None]:
    """Keep the node's own log lines out of the run's output, but never lose them.

    With no logging configured, Python prints every warning and error, traceback and
    all, to stderr.  A seed triggers a few from background jobs the plugins tolerate
    (and retry), which would bury a successful run's output.  They are tallied
    instead, for the caller to summarise; ``verbose`` leaves them to print as usual.
    When the run fails they go to ``log`` at once: the reason (a scan that held the
    manuscript, say) may be only there.
    """
    if verbose:
        yield
        return
    collector = _NodeLogCollector()
    root = logging.getLogger()
    root.addHandler(collector)
    try:
        yield
    except BaseException:
        for headline, count in collector.headlines.most_common(5):
            log(f"node log: {count}x {headline}")
        raise
    finally:
        root.removeHandler(collector)
        result.node_log = dict(collector.headlines)


# --------------------------------------------------------------------------- #
# Talking to the node
# --------------------------------------------------------------------------- #


def _describe(response: Any) -> str:
    try:
        body = response.json()
    except ValueError:
        return f"{response.status_code} {response.text[:200]}"
    if isinstance(body, dict):
        return f"{response.status_code} {body.get('title', '')}: {body.get('detail', '')}".strip()
    return f"{response.status_code} {body}"


def _problem_type(response: Any) -> Optional[str]:
    try:
        body = response.json()
    except ValueError:
        return None
    return body.get("type") if isinstance(body, dict) else None


def _require(response: Any, status: int, what: str) -> Any:
    if response.status_code != status:
        raise SeedError(f"{what}: the node answered {_describe(response)}")
    return response


def _stamp(anchor: datetime, *, days_ago: int = 0, seconds: int = 0) -> str:
    return (anchor - timedelta(days=days_ago) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _signed(key: SigningKey, record_type: str, body: dict, created: str, prev: Optional[str] = None) -> dict:
    return sign_record(
        {
            "v": 1,
            "type": record_type,
            "author": did_key_from_signing_key(key),
            "created": created,
            "prev": prev,
            "body": body,
            "proofs": [],
        },
        key,
    )


class _Actor:
    """One demo person, signed in to the node with their own key."""

    def __init__(self, http: TestClient, account: DemoAccount) -> None:
        self.http = http
        self.account = account
        self.key = account.signing_key()
        self._access: Optional[str] = None
        self._refresh: Optional[str] = None

    @property
    def did(self) -> str:
        return self.account.did

    @property
    def headers(self) -> dict[str, str]:
        assert self._access, "sign in first"
        return {"Authorization": f"Bearer {self._access}"}

    @property
    def tier(self) -> int:
        assert self._access, "sign in first"
        return int(decode_access_token(self._access).tier)

    def sign_in(self) -> None:
        challenge = self.http.post("/v1/auth/challenge", json={"did": self.did})
        nonce = _require(challenge, 200, f"sign-in challenge for {self.account.name}").json()["nonce"]
        signature = encode_signature(self.key.sign(nonce.encode("utf-8")).signature)
        verified = self.http.post(
            "/v1/auth/verify", json={"did": self.did, "nonce": nonce, "signature": signature}
        )
        self._keep(_require(verified, 200, f"sign-in for {self.account.name}"))

    def refresh(self) -> None:
        """Trade the refresh token for tokens that carry the account's current tier."""
        assert self._refresh, "sign in first"
        refreshed = self.http.post("/v1/auth/refresh", json={"refresh_token": self._refresh})
        self._keep(_require(refreshed, 200, f"token refresh for {self.account.name}"))

    def _keep(self, response) -> None:
        # The access token is in the body; the refresh token is delivered only
        # as the HttpOnly cookie, so read it out of the Set-Cookie header (the
        # supported channel for non-browser clients).
        self._access = response.json()["access_token"]
        self._refresh = _refresh_cookie(response)

    def record(self, record_type: str, body: dict, created: str, prev: Optional[str] = None) -> dict:
        return _signed(self.key, record_type, body, created, prev)

    def submit(self, record: dict, what: str) -> tuple[Optional[dict], bool]:
        """``POST /v1/records``; return ``(answer, False)``, or ``(None, True)`` if the node had it already."""
        response = self.http.post("/v1/records", json=record, headers=self.headers)
        return _outcome(response, what, (DUPLICATE_RECORD,))


def _refresh_cookie(response: Any) -> str:
    """The raw refresh token from a response's ``Set-Cookie`` header."""
    for header in response.headers.get_list("set-cookie"):
        if header.lower().startswith("scholium_refresh="):
            return header.split(";", 1)[0].split("=", 1)[1]
    raise SeedError(
        "the API did not set the scholium_refresh cookie: "
        + _describe(response)
    )


def _outcome(response: Any, what: str, duplicates: tuple[str, ...]) -> tuple[Optional[dict], bool]:
    if response.status_code == 201:
        return response.json(), False
    if response.status_code == 409 and _problem_type(response) in duplicates:
        return None, True
    raise SeedError(f"{what}: the node answered {_describe(response)}")


# --------------------------------------------------------------------------- #
# The run
# --------------------------------------------------------------------------- #


class _Seeder:
    def __init__(self, http: TestClient, keys: DemoKeys, log: Callable[[str], None], result: SeedResult) -> None:
        self.http = http
        self.anchor = keys.anchor
        self.log = log
        self.result = result
        self.people = people_by_slug()
        self.actors = {
            p.slug: _Actor(http, keys.account(p.slug, name=p.name, role=p.role)) for p in PEOPLE
        }
        self.names = {slug: person.name for slug, person in self.people.items()}

    def _at(self, paper: DemoPaper, seconds: int) -> str:
        """The ``created`` of a record ``seconds`` after ``paper`` was submitted."""
        return _stamp(self.anchor, days_ago=paper.days_ago, seconds=seconds)

    def run(self) -> None:
        self._appoint()
        self._sign_in()
        self._save_profiles()
        self._endorse()
        for paper in PAPERS:
            self.result.papers.append(self._publish(paper))
        for paper, seeded in zip(PAPERS, self.result.papers):
            self._review(paper, seeded)
        self.result.accounts = [
            SeededAccount(p.slug, p.name, p.role, self.actors[p.slug].tier, self.actors[p.slug].did)
            for p in PEOPLE
        ]

    # --- the people ------------------------------------------------------

    def _appoint(self) -> None:
        """Make the moderator and the reviewers what they are, the way an operator would."""
        for person in PEOPLE:
            if person.role == "author":
                continue  # authors earn tier 2 through an endorsement
            set_tier(self.actors[person.slug].did, person.tier)
        counts = Counter(p.role for p in PEOPLE if p.role != "author")
        self.log("appointed " + " and ".join(f"{n} {role}{'s' if n != 1 else ''}" for role, n in counts.items()))

    def _sign_in(self) -> None:
        for person in PEOPLE:
            actor = self.actors[person.slug]
            actor.sign_in()
            if person.role != "author" and actor.tier != person.tier:
                raise SeedError(f"{person.name} signed in at tier {actor.tier}, expected {person.tier}")

    def _save_profiles(self) -> None:
        for person in PEOPLE:
            actor = self.actors[person.slug]
            response = self.http.put(
                f"/v1/profiles/{actor.did}",
                json={"name": person.name, "affiliation": person.affiliation, "email": person.email},
                headers=actor.headers,
            )
            _require(response, 200, f"saving the profile of {person.name}")
        self.log(f"saved {len(PEOPLE)} profiles")

    def _endorse(self) -> None:
        """Reviewers endorse the authors, which is what grants tier 2 and the right to submit.

        The cast has endorsements for its reviewers as well: tier 3 alone does not
        let anyone start a paper, an endorsement in the category does.  The same goes
        for endorsing: a reviewer may only endorse in categories they are themself
        endorsed in, so the moderator endorses the reviewer who endorses the others.
        """
        # A record is dated by how many came before it, and the authors'
        # endorsements are the ones an earlier run may already have sent -- they
        # must keep their dates, so their ids.  So the dating order is: authors,
        # then the reviewers a reviewer endorsed, then the moderator's
        # endorsements of the reviewers.
        endorsed = [p for p in PEOPLE if p.endorsed_by is not None]

        def by_moderator(person: Person) -> bool:
            return self.actors[person.endorsed_by].tier >= TIER_FOR_ROLE["moderator"]

        dated = sorted(endorsed, key=lambda p: (by_moderator(p), p.role != "author"))
        first_second, made = {}, 0
        for person in dated:
            first_second[person.slug] = made
            made += len(person.endorsed_in)

        # An endorser may only endorse in categories they are themself endorsed in
        # (a moderator in any), so the moderator's endorsements are sent first.
        for person in sorted(dated, key=lambda p: not by_moderator(p)):
            endorser, endorsee = self.actors[person.endorsed_by], self.actors[person.slug]
            for step, category in enumerate(person.endorsed_in):
                record = endorser.record(
                    "endorsement",
                    {"endorsee": endorsee.did, "category": category, "statement": "Demo endorsement."},
                    _stamp(self.anchor, days_ago=_ENDORSEMENT_DAYS_AGO, seconds=first_second[person.slug] + step),
                )
                endorser.submit(record, f"{endorser.account.name}'s endorsement of {person.name} in {category}")
            endorsee.refresh()  # the new tier is in the next token
            if endorsee.tier < 2:
                raise SeedError(f"{person.name} is still tier {endorsee.tier} after being endorsed")
        self.log("endorsed the authors and the reviewers")

    # --- a paper ---------------------------------------------------------

    def _upload(self, data: bytes, what: str, *, actor: "Actor") -> str:
        # Uploads belong to the caller who creates them, so the submitter's
        # access token travels with both requests, not just the signed records.
        tus = {**actor.headers, "Tus-Resumable": "1.0.0"}
        created = self.http.post("/v1/uploads", headers={**tus, "Upload-Length": str(len(data))})
        location = _require(created, 201, f"starting the upload of {what}").headers["Location"]
        patched = self.http.patch(
            f"/v1/uploads/{location.rsplit('/', 1)[-1]}",
            content=data,
            headers={**tus, "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0"},
        )
        _require(patched, 204, f"uploading {what}")
        cid = patched.headers.get("Upload-Cid")
        if not cid:
            raise SeedError(f"uploading {what}: the node returned no content id")
        return cid

    def _publish(self, paper: DemoPaper) -> SeededPaper:
        submitter = self.actors[paper.submitter]
        author_dids = [self.actors[slug].did for slug, _ in paper.authors]

        pdf = build_pdf(paper.manuscript(self.names))
        file_cid = self._upload(pdf, f"the manuscript of {paper.title!r}", actor=submitter)
        manifest = submitter.record(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": file_cid,
                        "size": len(pdf),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
            self._at(paper, _MANIFEST),
        )
        submitter.submit(manifest, f"the manifest of {paper.title!r}")

        genesis = submitter.record(
            "paper.genesis",
            {
                "title": paper.title,
                "abstract": paper.abstract,
                "categories": list(paper.categories),
                "licence": LICENCE,
                "authors": author_dids,
            },
            self._at(paper, _GENESIS),
        )
        answer, duplicate = submitter.submit(genesis, f"the genesis of {paper.title!r}")
        short_id = (answer or {}).get("shortId") or derive_short_id(genesis["id"])

        version = submitter.record(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": paper.title,
                "abstract": paper.abstract,
                "authors": [
                    {"did": self.actors[slug].did, "position": position, "creditRoles": list(roles)}
                    for position, (slug, roles) in enumerate(paper.authors, start=1)
                ],
                "manifest": manifest["id"],
                "licence": LICENCE,
                "changeNote": "Initial version.",
                # As the browser signs it: the moderation page, the consent page and
                # the new-version form read the categories from this record, not the genesis.
                "categories": list(paper.categories),
            },
            self._at(paper, _VERSION),
            prev=genesis["id"],
        )
        submitter.submit(version, f"version 1 of {paper.title!r}")

        # Every listed author consents; the last consent starts the scan.
        for step, (slug, roles) in enumerate(paper.authors):
            consent = self.actors[slug].record(
                "coauthor.consent",
                {"version": version["id"], "role": roles[0], "decision": "accept"},
                self._at(paper, _CONSENT + step),
            )
            self.actors[slug].submit(consent, f"{self.names[slug]}'s consent to {paper.title!r}")
            # The consent this actor just signed answers the request that was
            # sent when the version went out for consent, so leave no stale
            # unread "Consent request" on their /me.
            self._mark_consent_request_read(self.actors[slug], version["id"])
        jobs.run_pending()  # the scan, which passes the version to moderation

        state = self._state(version["id"], paper)
        if state == MODERATION and paper.listed:
            self._list(paper, version["id"], self._at(paper, _DECISION))
            state = self._state(version["id"], paper)
        if paper.listed and state != LISTED:
            raise SeedError(f"{paper.title!r} is {state!r} on the node, expected it to be listed")

        ai_reviewed = False
        if state == LISTED:
            jobs.run_pending()  # the advisory AI pre-review, queued when the paper was listed
            ai_reviewed = self._has_ai_review(short_id)
        self.log(f"{short_id}  {state:<10}  {paper.title}")
        return SeededPaper(
            slug=paper.slug,
            title=paper.title,
            short_id=short_id,
            paper_cid=genesis["id"],
            version_cid=version["id"],
            state=state,
            created=not duplicate,
            ai_reviewed=ai_reviewed,
        )

    def _mark_consent_request_read(self, actor: _Actor, version_cid: str) -> None:
        """Mark the unread consent request for ``version_cid`` as read.

        The seed signs each author's consent as soon as the request goes out,
        so leaving that request unread would ask them to do what they have
        already done.
        """
        response = self.http.get("/v1/me/notifications", headers=actor.headers)
        rows = _require(
            response, 200, f"reading {actor.account.name}'s notifications"
        ).json()
        for row in rows:
            if row.get("kind") != "consent.request" or row.get("read"):
                continue
            payload = row.get("payload") or {}
            if payload.get("version_cid") != version_cid:
                continue
            marked = self.http.post(
                f"/v1/me/notifications/{row['id']}/read", headers=actor.headers
            )
            _require(marked, 200, f"marking {actor.account.name}'s consent request read")

    def _state(self, version_cid: str, paper: DemoPaper) -> str:
        row = get_version(version_cid)
        if row is None:
            raise SeedError(f"{paper.title!r}: the node has no version {version_cid}")
        state = str(row.state)
        if state not in (MODERATION, LISTED):
            raise SeedError(
                f"{paper.title!r} is {state!r} on the node after the scan, expected 'moderation' "
                "(is a consent missing, or did the scan hold the manuscript?)"
            )
        return state

    def _list(self, paper: DemoPaper, version_cid: str, created: str) -> None:
        moderator = self.actors[next(p.slug for p in PEOPLE if p.role == "moderator")]
        policies = _require(self.http.get("/v1/moderation/policies"), 200, "reading the moderation policies").json()
        clauses = [clause["id"] for clause in policies]
        clause = _LISTING_CLAUSE if _LISTING_CLAUSE in clauses else clauses[0]
        decision = moderator.record(
            "moderation.decision",
            {"target": version_cid, "action": "list", "clause": clause, "reason": "In scope and scholarly form."},
            created,
        )
        moderator.submit(decision, f"the decision to list {paper.title!r}")

    def _has_ai_review(self, short_id: str) -> bool:
        """A pre-review counts as done only once its signed record is in the log.

        The endpoint answers from the node's own tables, which the job fills in
        even when no signing key meant no record could be appended; the summary
        must not claim a pre-review that was never signed.
        """
        report = self.http.get(f"/v1/papers/{short_id}/ai-reviews")
        if report.status_code != 200:
            return False
        review_cid = (report.json() or {}).get("reviewCid")
        return bool(review_cid) and self.http.get(f"/v1/records/{review_cid}").status_code == 200

    # --- reviews ---------------------------------------------------------

    def _review(self, paper: DemoPaper, seeded: SeededPaper) -> None:
        if not paper.reviews:
            return
        # Seal every review first.  The report gate opens when a version has
        # two independent commits, and a reveal before that is refused so no
        # report enters the public log early -- so the demo's revealed review
        # cannot be revealed until its co-review has been committed.
        sealed = [
            self._seal_review(paper, seeded, review, step)
            for step, review in enumerate(paper.reviews)
        ]
        for sealed_review in sealed:
            if not sealed_review["review"].reveal:
                seeded.reviews_sealed += 1
                continue
            self._reveal_review(sealed_review)
            seeded.reviews_revealed += 1
        self.log(
            f"{seeded.short_id}  reviews: {seeded.reviews_revealed} revealed, {seeded.reviews_sealed} sealed"
        )

    def _seal_review(
        self, paper: DemoPaper, seeded: SeededPaper, review: DemoReview, step: int
    ) -> dict:
        """Commit ``review`` and return everything a later reveal needs."""
        genesis_cid = seeded.paper_cid
        reviewer = self.actors[review.reviewer]
        # A review is signed by a key made for that one paper, so the record does
        # not say who wrote it.  Derive it from the reviewer's own key so a re-run
        # signs the same review.
        secret = hmac.new(bytes(reviewer.key), b"scholium-demo:review-secret", hashlib.sha256).digest()
        review_key = SigningKey(hashlib.sha256(b"review-key|" + secret + genesis_cid.encode()).digest())
        what = f"{reviewer.account.name}'s review of {paper.title!r}"

        body = {
            "target": seeded.version_cid,
            "paper": genesis_cid,
            "scores": {
                dimension: {
                    "score": score,
                    "justification": f"{dimension.capitalize()} is {_JUSTIFICATION[score]} ({score} of 5).",
                }
                for dimension, score in zip(RUBRIC, review.scores)
            },
            "confidence": review.confidence,
            "recommendation": review.recommendation,
            "report": review.report,
            "reviewKey": did_key_from_signing_key(review_key),
            "nullifier": hashlib.sha256(secret + b"|" + genesis_cid.encode()).hexdigest(),
            "salt": hmac.new(secret, b"salt|" + genesis_cid.encode(), hashlib.sha256).hexdigest()[:32],
        }
        commitment = commitment_digest(body)
        commit = _signed(
            review_key,
            "review.commit",
            {
                "target": seeded.version_cid,
                "commitment": commitment,
                "reviewKey": body["reviewKey"],
                "nullifier": body["nullifier"],
            },
            self._at(paper, _REVIEW_COMMIT + 60 * step),
        )
        _outcome(
            self.http.post("/v1/reviews/commit", json=commit, headers=reviewer.headers),
            f"committing {what}",
            (DUPLICATE_RECORD, REVIEW_ALREADY_COMMITTED),
        )
        return {
            "review": review,
            "paper": paper,
            "reviewer": reviewer,
            "review_key": review_key,
            "body": body,
            "commitment": commitment,
            "what": what,
            "step": step,
        }

    def _reveal_review(self, sealed_review: dict) -> None:
        """Reveal a review that ``_seal_review`` committed."""
        reveal = _signed(
            sealed_review["review_key"],
            "review.formal",
            {**sealed_review["body"], "commitment": sealed_review["commitment"]},
            self._at(sealed_review["paper"], _REVIEW_REVEAL + 60 * sealed_review["step"]),
        )
        _outcome(
            self.http.post(
                "/v1/reviews/reveal", json=reveal, headers=sealed_review["reviewer"].headers
            ),
            f"revealing {sealed_review['what']}",
            (DUPLICATE_RECORD, REVIEW_ALREADY_REVEALED),
        )

