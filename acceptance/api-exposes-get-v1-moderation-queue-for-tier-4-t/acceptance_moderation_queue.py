"""Acceptance tests for: API exposes ``GET /v1/moderation/queue`` for tier 4
(moderation plugin, feature 70).

The endpoint returns the versions waiting in ``moderation`` state, each with
the automated signals a moderator decides with: the paper's category, the
version's age in hours, the ``similarity_pct`` and ``references_unresolved``
saved by the automated checks (features 66 and 67), the result of the file
scan (feature 63) and whether the submitting account is new.

Criteria (app_spec.xml, feature 70):

* ``GET /v1/moderation/queue`` as a tier-1 user returns ``403`` problem
  details.
* ``GET /v1/moderation/queue`` as a tier-4 user returns ``200`` with
  ``similarity_pct`` and scan fields per entry.

How the scene is set up
-----------------------

The paper, its version and the automated signals belong to other plugins, so
they are put in place the way the sibling suites do it:

* a ``paper.genesis``, a ``manifest`` and a ``paper.version`` record signed by
  one author and appended to the event log;
* the paper and version indexed through the submissions plugin's own exported
  ``save_paper`` / ``save_version`` -- the calls its handlers make -- with the
  version in state ``moderation``;
* ``check_results`` filled through the checks plugin's exported
  ``save_check_result`` (``similarity_pct``, ``references_total``,
  ``references_unresolved``);
* the manuscript stored in the content store, its blob marked scan-``passed``
  and passing ``scan_reports`` rows recorded, exactly the state a version
  reaches after feature 63 scans it clean;
* an ``accounts`` row for the author, old or new, which is what the
  new-account flag describes.

Everything the criteria are about is then read through the public surface:
``GET /v1/moderation/queue`` with a tier-1 or a tier-4 access token.

The response shape is not pinned beyond what the criteria say, so the tests
locate an entry by the values that identify the version (its cid, its
``sch:`` id or its unique title) and accept the fields at the top level of an
entry or nested in it.  They never compare a whole response object: later
features may add fields.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from nacl.signing import SigningKey
from scholium_record_core import (
    compute_file_id,
    derive_short_id,
    did_key_from_signing_key,
    sign_record,
    validate_envelope,
    verify_record,
)

from app import db
from app.modules import checks, content, ledger, sanitizer
from app.modules.identity.models import Account, ensure_account_table
from app.modules.submissions import VersionAuthor, save_paper, save_version
from app.security import issue_access_token

QUEUE_URL = "/v1/moderation/queue"

#: The category every acceptance paper is filed under.
CATEGORY = "cs.CR"


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def _now() -> datetime:
    """Now as the naive UTC the database columns store."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _bearer(did: str, tier: int) -> dict[str, str]:
    """An ``Authorization`` header carrying a token for ``did`` at ``tier``."""
    return {"Authorization": f"Bearer {issue_access_token(did, tier)}"}


def _all_strings(value: Any) -> Iterator[str]:
    """Every string anywhere inside a JSON value."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _all_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_strings(item)


def _all_dicts(value: Any) -> Iterator[dict]:
    """Every dict anywhere inside a JSON value, including ``value`` itself."""
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _all_dicts(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_dicts(item)


def _entries(payload: Any) -> list[Any]:
    """The queue's per-version entries, whether wrapped or a bare list."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("entries", "items", "queue", "versions", "results", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
        # A single list of objects anywhere in the envelope is the entry list.
        list_values = [
            value
            for value in payload.values()
            if isinstance(value, list) and all(isinstance(item, dict) for item in value)
        ]
        if len(list_values) == 1:
            return list_values[0]
        # A mapping keyed by version/paper id still has one dict per entry.
        dict_values = [value for value in payload.values() if isinstance(value, dict)]
        if dict_values and len(dict_values) == len(payload):
            return dict_values
    raise AssertionError(
        "GET /v1/moderation/queue should answer with a list of queue entries; "
        f"got {type(payload).__name__}: {payload!r}"
    )


def _lookup(entry: dict, *names: str) -> Any:
    """The first of ``names`` found on ``entry`` or nested inside it.

    The feature fixes the field names but not whether they sit at the top
    level of an entry or under an object such as ``signals``, so both are
    accepted.  A missing field is reported with the keys that were present.
    """
    for name in names:
        if name in entry:
            return entry[name]
    for mapping in _all_dicts(entry):
        for name in names:
            if name in mapping:
                return mapping[name]
    present = sorted({key for mapping in _all_dicts(entry) for key in mapping})
    raise AssertionError(
        f"queue entry has none of the fields {names!r}; present fields: {present}"
    )


def _scan_value(entry: dict) -> Any:
    """The entry's scan result, under any of the names the spec suggests."""
    try:
        return _lookup(entry, "scan_result", "scan_status", "scan", "scan_report")
    except AssertionError:
        pass
    # Last resort: a field whose name mentions the scan, preferring one that
    # reads as a verdict over, say, a "scanned_at" timestamp.
    candidates: list[tuple[int, Any]] = []
    for mapping in _all_dicts(entry):
        for key, value in mapping.items():
            if not isinstance(key, str) or not key.lower().startswith("scan"):
                continue
            lowered = key.lower()
            rank = 0 if any(word in lowered for word in ("result", "status", "passed")) else 1
            candidates.append((rank, value))
    if candidates:
        return min(candidates, key=lambda pair: pair[0])[1]
    present = sorted({key for mapping in _all_dicts(entry) for key in mapping})
    raise AssertionError(
        f"queue entry has no scan field; present fields: {present}"
    )


#: Values a file scan is reported with in this project.
PASSED_SCAN_WORDS = frozenset({"passed", "pass", "clean", "ok", "clear", "no findings"})
FAILED_SCAN_WORDS = frozenset(
    {"failed", "fail", "blocked", "rejected", "unscanned", "scanning", "pending"}
)
VERDICT_WORDS = PASSED_SCAN_WORDS | FAILED_SCAN_WORDS


def _scan_passed(value: Any) -> bool:
    """Whether ``value`` says the version's files passed scanning."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in PASSED_SCAN_WORDS
    if isinstance(value, dict):
        for key in ("result", "status", "scan_result", "scan_status"):
            if key in value:
                return _scan_passed(value[key])
        if isinstance(value.get("passed"), bool):
            return value["passed"]
        # e.g. {"checks": [], "findings": []}: nothing found is a pass.
        if "findings" in value and isinstance(value["findings"], list):
            return not value["findings"]
        # e.g. {"javascript": "passed", "hidden_text": "passed"}, or a list of
        # per-check objects, ignoring metadata such as a scan timestamp.
        verdicts = [
            item
            for item in value.values()
            if isinstance(item, (dict, list, bool))
            or (isinstance(item, str) and item.strip().lower() in VERDICT_WORDS)
        ]
        if verdicts:
            return all(_scan_passed(item) for item in verdicts)
        return not value  # an empty object carries no finding
    if isinstance(value, (list, tuple)):
        return all(_scan_passed(item) for item in value)
    return False


# --------------------------------------------------------------------------- #
# The scene: a paper version in a given state with its automated signals
# --------------------------------------------------------------------------- #


class Scene:
    """One paper with one version, its checks, its scan and its author account."""

    def __init__(
        self,
        *,
        state: str = "moderation",
        similarity_pct: float = 42.5,
        references_total: int = 6,
        references_unresolved: int = 3,
        account_age: timedelta = timedelta(days=400),
        created: datetime | None = None,
    ) -> None:
        self.tag = uuid.uuid4().hex
        self.seed = SigningKey.generate()
        self.did = did_key_from_signing_key(self.seed)
        self.title = f"Moderation queue acceptance paper {self.tag}"
        self.abstract = "A paper waiting for a moderator."
        self.created = _now() if created is None else created
        self.state = state

        manuscript = f"%PDF-1.7 acceptance manuscript {self.tag}".encode()
        manuscript_cid = compute_file_id(manuscript)

        genesis = self._sign(
            "paper.genesis",
            {
                "seed": self.tag,
                "title": self.title,
                "abstract": self.abstract,
                "categories": [CATEGORY],
                "licence": "CC-BY-4.0",
                "authors": [self.did],
            },
        )
        manifest = self._sign(
            "manifest",
            {
                "files": [
                    {
                        "path": "main.pdf",
                        "cid": manuscript_cid,
                        "size": len(manuscript),
                        "mediaType": "application/pdf",
                        "role": "manuscript",
                    }
                ]
            },
        )
        version = self._sign(
            "paper.version",
            {
                "paper": genesis["id"],
                "n": 1,
                "title": self.title,
                "abstract": self.abstract,
                "authors": [self.did],
                "manifest": manifest["id"],
                "licence": "CC-BY-4.0",
                "changeNote": "First version.",
            },
            prev=genesis["id"],
        )

        # The clean scan a version in moderation has just been through: bytes
        # stored, blob passed, every check passing.
        blob = content.store_bytes(manuscript, media_type="application/pdf")
        assert blob.cid == manuscript_cid, (blob.cid, manuscript_cid)
        content.set_scan_status(blob.cid, content.SCAN_PASSED)
        for check_name in ("javascript", "embedded_files", "hidden_text"):
            sanitizer.record_report(blob.cid, check_name, result=sanitizer.RESULT_PASSED)

        for record in (genesis, manifest, version):
            ledger.append(record, received_at=self.created)

        # Index the paper and its version the way the submissions handlers do.
        save_paper(paper_cid=genesis["id"], categories=(CATEGORY,))
        save_version(
            version_cid=version["id"],
            paper_cid=genesis["id"],
            n=1,
            title=self.title,
            abstract=self.abstract,
            manifest_cid=manifest["id"],
            licence="CC-BY-4.0",
            prev_cid=genesis["id"],
            change_note="First version.",
            authors=(VersionAuthor(self.did, 1, ("Conceptualization",)),),
            state=state,
        )

        # The automated checks' shared row (features 66 and 67).
        checks.save_check_result(
            version["id"],
            similarity_pct=similarity_pct,
            references_total=references_total,
            references_unresolved=references_unresolved,
        )

        # The author's account and its age, which the new-account flag reports.
        ensure_account_table()
        with db.SessionLocal() as session:
            account = session.get(Account, self.did)
            if account is None:
                account = Account(did=self.did, tier=2, created_at=_now() - account_age)
                session.add(account)
            else:  # pragma: no cover - a DID is never reused
                account.tier = 2
                account.created_at = _now() - account_age
            session.commit()

        #: What identifies this version in a queue entry.
        self.version_cid: str = version["id"]
        self.paper_cid: str = genesis["id"]
        self.short_id: str = derive_short_id(genesis["id"])
        self.similarity_pct = similarity_pct
        self.references_unresolved = references_unresolved

    def _sign(self, record_type: str, body: dict, prev: str | None = None) -> dict:
        """A complete signed record; the fixture fails if it is not valid."""
        record = sign_record(
            {
                "v": 1,
                "type": record_type,
                "author": self.did,
                "created": self.created.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "prev": prev,
                "body": body,
                "proofs": [],
            },
            self.seed,
        )
        # Guard the fixture itself: a failure further on can only be the feature's.
        assert verify_record(record)
        assert validate_envelope(record) == [], validate_envelope(record)
        return record

    @property
    def needles(self) -> tuple[str, ...]:
        """Values that identify this version wherever a response echoes it."""
        return (self.version_cid, self.short_id, self.title)

    def matches(self, entry: Any) -> bool:
        """Whether ``entry`` is this scene's version."""
        strings = set(_all_strings(entry))
        return any(needle in strings for needle in self.needles)


@pytest.fixture
def moderator() -> dict[str, str]:
    """A tier-4 (Moderator) caller's auth header."""
    return _bearer(did_key_from_signing_key(SigningKey.generate()), 4)


def _queue(client, headers: dict[str, str]) -> list[Any]:
    """``GET /v1/moderation/queue`` -- must answer 200; return its entries."""
    response = client.get(QUEUE_URL, headers=headers)
    assert response.status_code == 200, response.text
    return _entries(response.json())


def _queue_entry(client, headers: dict[str, str], scene: Scene) -> dict:
    """The queue entry for ``scene``; the scene always goes in the queue."""
    entries = _queue(client, headers)
    for entry in entries:
        if scene.matches(entry):
            assert isinstance(entry, dict), entry
            return entry
    raise AssertionError(
        f"version {scene.version_cid} (state {scene.state!r}) is missing from "
        f"the moderation queue: {entries!r}"
    )


# --------------------------------------------------------------------------- #
# Criteria
# --------------------------------------------------------------------------- #


def test_tier_1_user_gets_403_problem_details(client):
    """A tier-1 (Member) caller may not read the moderation queue."""
    response = client.get(
        QUEUE_URL, headers=_bearer(did_key_from_signing_key(SigningKey.generate()), 1)
    )

    assert response.status_code == 403, response.text
    assert response.headers["content-type"].startswith("application/problem+json")

    body = response.json()
    assert body["status"] == 403
    assert body["required_tier"] == 4
    assert body["caller_tier"] == 1


def test_tier_4_user_gets_200_with_similarity_and_scan_fields_per_entry(
    client, moderator
):
    """A tier-4 caller reads a moderation entry carrying the automated signals."""
    scene = Scene(
        state="moderation",
        similarity_pct=42.5,
        references_unresolved=3,
        created=_now() - timedelta(hours=100),
    )

    entry = _queue_entry(client, moderator, scene)

    assert _lookup(entry, "similarity_pct") == pytest.approx(scene.similarity_pct)
    assert _lookup(entry, "references_unresolved") == scene.references_unresolved

    # Every entry also says where the paper is filed, how long it has waited
    # and how the file scan went.
    category = _lookup(entry, "category", "categories")
    if isinstance(category, (list, tuple)):
        assert CATEGORY in category, entry
    else:
        assert category == CATEGORY, entry

    age_hours = _lookup(entry, "age_hours")
    assert isinstance(age_hours, (int, float)) and not isinstance(age_hours, bool)
    assert age_hours >= 0, entry

    assert _scan_passed(_scan_value(entry)), entry

    new_account = _lookup(entry, "new_account", "is_new_account")
    assert isinstance(new_account, bool), entry


def test_queue_lists_only_versions_in_moderation(client, moderator):
    """A version still in awaiting_consent is not a moderation queue entry."""
    waiting = Scene(state="awaiting_consent")
    moderation = Scene(state="moderation")

    entries = _queue(client, moderator)

    assert any(moderation.matches(entry) for entry in entries), entries
    assert not any(waiting.matches(entry) for entry in entries), entries


def test_new_account_flag_reflects_the_submitting_account_age(client, moderator):
    """An account created moments ago is flagged new; a long-standing one is not."""
    established = Scene(state="moderation", account_age=timedelta(days=400))
    brand_new = Scene(state="moderation", account_age=timedelta(hours=1))

    old_entry = _queue_entry(client, moderator, established)
    new_entry = _queue_entry(client, moderator, brand_new)

    assert _lookup(old_entry, "new_account", "is_new_account") is False, old_entry
    assert _lookup(new_entry, "new_account", "is_new_account") is True, new_entry
