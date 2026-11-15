"""Tests for tombstoning content (moderation plugin, feature 73).

A ``moderation.decision`` with ``action: tombstone`` saves the cid to the
``denylist`` table and deletes the blob bytes, while the envelope and the log
entry remain and verification still passes.

The record-core schema does not yet list ``tombstone`` among the actions (a
shared edit reported for the operator), so ingest would refuse the record
before this plugin sees it.  The tests that go through ``POST`` therefore use
the ``tombstone_schema`` fixture: the shipped schemas, copied, with that one
word added to the action enum -- the schema as it will be once the edit lands.
``test_the_shipped_schema_lists_every_action`` is the tripwire for that edit.
"""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import (
    CHECK_NAMES,
    compute_file_id,
    schema_dir,
    sign_record,
    verify_paper,
)

from app.main import app
from app.modules import content, ledger, moderation, submissions
from app.modules.moderation import (
    ModerationDecision,
    UnknownDecisionTarget,
    get_denylist_entry,
    handle_moderation_decision,
    resolve_scope,
    tombstone_cid,
    tombstone_target,
)
from app.modules.moderation import tombstones
from app.settings import settings

from .test_decisions import (
    DECISIONS_URL,
    RECORDS_URL,
    Moderator,
    Submission,
    _problem,
    _timestamp,
)

#: The clause whose text says the bytes are deleted and the cid denylisted.
UNLAWFUL = "MOD-05"


# --------------------------------------------------------------------------- #
# Fixtures and the scene
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def content_root(tmp_path, monkeypatch) -> Path:
    """A private blob directory: these tests delete files."""
    root = tmp_path / "content"
    monkeypatch.setattr(settings, "CONTENT_DIR", str(root))
    return root


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def moderator() -> Moderator:
    return Moderator()


@pytest.fixture
def subscribed():
    """Put the package's ledger subscription back (other suites clear it)."""
    moderation._install_ledger_subscriber()


@pytest.fixture
def tombstone_schema(tmp_path, monkeypatch) -> None:
    """The record-core schemas with ``tombstone`` added to ``moderation.decision``."""
    copy = tmp_path / "schemas"
    shutil.copytree(schema_dir(), copy)
    path = copy / "moderation.decision.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    actions = document["properties"]["action"]["enum"]
    if "tombstone" not in actions:
        actions.append("tombstone")
    path.write_text(json.dumps(document), encoding="utf-8")
    monkeypatch.setenv("SCHOLIUM_SCHEMA_DIR", str(copy))


class StoredSubmission(Submission):
    """A submission whose manuscript is really in the blob store, and consented to."""

    def __init__(self, state: str = "listed") -> None:
        super().__init__(state=state)
        blob = content.store_bytes(self.manuscript, media_type="application/pdf")
        content.set_scan_status(blob.cid, content.SCAN_PASSED)
        assert blob.cid == self.manifest_file_cid, "the stored bytes are the manifest's file"
        self.file_cid: str = blob.cid
        self.consent = self._sign(
            "coauthor.consent",
            {"version": self.version_cid, "role": "Conceptualization", "decision": "accept"},
        )
        ledger.append(self.consent)

    @property
    def manifest_file_cid(self) -> str:
        return compute_file_id(self.manuscript)


def tombstone_decision(moderator: Moderator, target: str, **extra) -> dict:
    """A signed ``moderation.decision`` tombstoning ``target`` under MOD-05."""
    body = {
        "target": target,
        "action": "tombstone",
        "clause": UNLAWFUL,
        "reason": f"Removed by order {uuid.uuid4().hex}",
        **extra,
    }
    return sign_record(
        {
            "v": 1,
            "type": moderation.DECISION_TYPE,
            "author": moderator.did,
            "created": _timestamp(),
            "prev": None,
            "body": body,
            "proofs": [],
        },
        moderator.seed,
    )


def stored_file(data: bytes | None = None):
    """Some bytes in the blob store that the sanitizer has passed."""
    blob = content.store_bytes(data or uuid.uuid4().bytes * 4, media_type="text/plain")
    return content.set_scan_status(blob.cid, content.SCAN_PASSED)


# --------------------------------------------------------------------------- #
# tombstone_cid: the denylist row and the bytes
# --------------------------------------------------------------------------- #


def test_tombstone_cid_saves_the_cid_and_deletes_the_bytes(content_root):
    blob = stored_file()
    assert content.exists(blob.cid)

    outcome = tombstone_cid(blob.cid, "decision-1")

    assert outcome.cid == blob.cid
    assert outcome.decision_cid == "decision-1"
    assert outcome.bytes_deleted is True
    assert not content.exists(blob.cid)
    assert not (content_root / blob.cid).exists()
    row = get_denylist_entry(blob.cid)
    assert (row.cid, row.decision_cid) == (blob.cid, "decision-1")
    assert content.is_tombstoned(blob.cid)


def test_tombstoning_leaves_the_blobs_row(content_root):
    blob = stored_file()

    tombstone_cid(blob.cid, "decision-1")

    # A manifest listing the file is still a manifest this node can show.
    kept = content.get_blob(blob.cid)
    assert kept is not None
    assert (kept.cid, kept.size) == (blob.cid, blob.size)


def test_the_first_decision_stays_on_record():
    blob = stored_file()
    tombstone_cid(blob.cid, "first")

    again = tombstone_cid(blob.cid, "second")

    assert again.decision_cid == "first"
    assert again.bytes_deleted is False
    assert get_denylist_entry(blob.cid).decision_cid == "first"


def test_a_repeat_deletes_bytes_that_were_stored_again():
    data = uuid.uuid4().bytes * 4
    blob = stored_file(data)
    tombstone_cid(blob.cid, "first")
    # The upload path does not consult the denylist, so the bytes can come back.
    content.store_bytes(data)
    assert content.exists(blob.cid)

    outcome = tombstone_cid(blob.cid, "second")

    assert outcome.bytes_deleted is True
    assert not content.exists(blob.cid)
    assert outcome.decision_cid == "first"


def test_a_cid_the_node_never_held_is_still_denylisted():
    cid = compute_file_id(uuid.uuid4().bytes)
    assert content.get_blob(cid) is None

    outcome = tombstone_cid(cid, "decision-1")

    assert outcome.bytes_deleted is False
    assert get_denylist_entry(cid).decision_cid == "decision-1"
    assert content.is_tombstoned(cid)


@pytest.mark.parametrize("bad", ["", "not-a-cid", "../../etc/passwd", "bafyreiabc"])
def test_a_malformed_cid_changes_nothing(bad):
    with pytest.raises(ValueError):
        tombstone_cid(bad, "decision-1")

    assert get_denylist_entry(bad) is None


def test_a_failed_delete_leaves_the_cid_denylisted_and_a_retry_finishes(monkeypatch):
    blob = stored_file()
    real = tombstones._delete_bytes

    def broken(cid: str) -> bool:
        raise PermissionError("read-only volume")

    monkeypatch.setattr(tombstones, "_delete_bytes", broken)
    with pytest.raises(PermissionError):
        tombstone_cid(blob.cid, "decision-1")
    # Denylisted already: nothing is served while the bytes are still on disk.
    assert content.is_tombstoned(blob.cid)
    assert content.exists(blob.cid)

    monkeypatch.setattr(tombstones, "_delete_bytes", real)
    outcome = tombstone_cid(blob.cid, "decision-2")

    assert outcome.bytes_deleted is True
    assert outcome.decision_cid == "decision-1"
    assert not content.exists(blob.cid)


# --------------------------------------------------------------------------- #
# What a target stands for
# --------------------------------------------------------------------------- #


def test_a_file_target_is_just_that_file():
    cid = compute_file_id(uuid.uuid4().bytes)

    scope = resolve_scope(cid)

    assert scope.file_cids == (cid,)
    assert scope.version_cids == ()


def test_a_version_target_is_its_manifests_files():
    submission = StoredSubmission()

    scope = resolve_scope(submission.version_cid)

    assert scope.file_cids == (submission.file_cid,)
    assert scope.version_cids == (submission.version_cid,)


def test_a_paper_target_is_every_version_of_the_paper():
    submission = StoredSubmission()

    scope = resolve_scope(submission.paper_cid)

    assert scope.file_cids == (submission.file_cid,)
    assert scope.version_cids == (submission.version_cid,)


@pytest.mark.parametrize("bad", ["", "nonsense", "bafyreinotarecordthisnodeholds", None, 7])
def test_any_other_target_is_unknown(bad):
    with pytest.raises(UnknownDecisionTarget) as raised:
        resolve_scope(bad)

    assert raised.value.status_code == 422
    assert "file id" in raised.value.detail


def test_tombstone_target_takes_the_files_and_the_version_out():
    submission = StoredSubmission(state="listed")

    outcome = tombstone_target(submission.version_cid, "decision-1", actor="did:key:zMod")

    assert [t.cid for t in outcome] == [submission.file_cid]
    assert not content.exists(submission.file_cid)
    assert content.is_tombstoned(submission.file_cid)
    assert submission.state == "rejected"


@pytest.mark.parametrize("state", ["awaiting_consent", "scanning", "moderation", "listed", "held", "rejected"])
def test_a_takedown_is_never_refused_for_the_versions_state(state):
    submission = StoredSubmission(state=state)

    tombstone_target(submission.version_cid, "decision-1", actor="did:key:zMod")

    assert content.is_tombstoned(submission.file_cid)
    assert not content.exists(submission.file_cid)
    # ``awaiting_consent`` has a natural edge to ``rejected`` too, so every
    # version ends up out of the catalog.
    assert submission.state == "rejected"


def test_a_file_target_leaves_every_versions_state_alone():
    submission = StoredSubmission(state="listed")

    tombstone_target(submission.file_cid, "decision-1", actor="did:key:zMod")

    assert content.is_tombstoned(submission.file_cid)
    assert submission.state == "listed"


# --------------------------------------------------------------------------- #
# The signed decision, end to end
# --------------------------------------------------------------------------- #


def test_the_handler_accepts_a_tombstone_of_each_kind_of_target(moderator):
    submission = StoredSubmission()
    for target in (submission.version_cid, submission.paper_cid, submission.file_cid):
        decision = tombstone_decision(moderator, target)

        assert handle_moderation_decision(decision) == "tombstoned"

    # Validating changes nothing.
    assert content.exists(submission.file_cid)
    assert not content.is_tombstoned(submission.file_cid)
    assert submission.state == "listed"


def test_the_handler_refuses_an_unknown_target_and_an_unknown_clause(moderator):
    unknown = tombstone_decision(moderator, "not-a-cid")
    no_clause = tombstone_decision(moderator, compute_file_id(b"x"), clause="MOD-404")

    with pytest.raises(UnknownDecisionTarget):
        handle_moderation_decision(unknown)
    with pytest.raises(moderation.UnknownPolicyClause):
        handle_moderation_decision(no_clause)


def test_tombstoning_a_version_through_the_endpoint(client, moderator, tombstone_schema):
    submission = StoredSubmission(state="listed")
    decision = tombstone_decision(moderator, submission.version_cid)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["id"] == decision["id"]
    assert body["action"] == "tombstone"
    assert body["state"] == "rejected"
    assert body["shortId"] == f"{submission.short_id}/v1"
    # The cid is saved to the denylist, with the decision that put it there...
    row = get_denylist_entry(submission.file_cid)
    assert row is not None and row.decision_cid == decision["id"]
    # ...the bytes are gone, and the content endpoint says why.
    assert not content.exists(submission.file_cid)
    gone = client.get(f"/v1/content/{submission.file_cid}")
    assert gone.status_code == 451
    # The decision is saved like any other.
    saved = moderation.get_decision(decision["id"])
    assert isinstance(saved, ModerationDecision)
    assert (saved.action, saved.clause, saved.target_cid) == (
        "tombstone",
        UNLAWFUL,
        submission.version_cid,
    )


def test_tombstoning_a_file_reports_tombstoned(client, moderator, tombstone_schema):
    submission = StoredSubmission(state="listed")
    decision = tombstone_decision(moderator, submission.file_cid)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["state"] == "tombstoned"
    assert body["shortId"] is None
    assert get_denylist_entry(submission.file_cid).decision_cid == decision["id"]
    assert submission.state == "listed"


def test_a_tombstone_arrives_through_post_records_too(client, moderator, tombstone_schema, subscribed):
    submission = StoredSubmission(state="listed")
    decision = tombstone_decision(moderator, submission.version_cid)

    response = client.post(RECORDS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    assert get_denylist_entry(submission.file_cid).decision_cid == decision["id"]
    assert not content.exists(submission.file_cid)
    assert submission.state == "rejected"


def test_an_unknown_target_is_422_and_nothing_is_stored(client, moderator, tombstone_schema):
    stray = tombstone_decision(moderator, "bafyreiunknowntarget")

    response = client.post(DECISIONS_URL, json=stray, headers=moderator.headers)

    body = _problem(response, 422)
    assert body["type"] == "urn:scholium:problem:unknown-decision-target"
    assert client.get(f"{RECORDS_URL}/{stray['id']}").status_code == 404
    assert get_denylist_entry("bafyreiunknowntarget") is None


def test_only_a_moderators_signature_can_tombstone(client, tombstone_schema):
    submission = StoredSubmission(state="listed")
    reviewer = Moderator(tier=3, token_tier=4)
    decision = tombstone_decision(reviewer, submission.version_cid)

    response = client.post(DECISIONS_URL, json=decision, headers=reviewer.headers)

    _problem(response, 403)
    assert content.exists(submission.file_cid)
    assert get_denylist_entry(submission.file_cid) is None


def test_citing_the_unlawful_content_clause_does_not_tombstone_by_itself(client, moderator):
    """Bytes are only ever deleted by an explicit ``tombstone`` decision.

    MOD-05 says unlawful content is delisted *and* tombstoned, but deleting is
    irreversible and a clause id is just text in a replaceable policies file, so
    a ``delist`` that cites it only delists.
    """
    submission = StoredSubmission(state="listed")

    response = moderator.post(client, submission, "delist", clause=UNLAWFUL)

    assert response.status_code == 201, response.text
    assert submission.state == "rejected"
    assert content.exists(submission.file_cid)
    assert get_denylist_entry(submission.file_cid) is None
    assert client.get(f"/v1/content/{submission.file_cid}").status_code == 200


# --------------------------------------------------------------------------- #
# The envelope and log entry remain, and verification still passes
# --------------------------------------------------------------------------- #


def test_the_records_and_the_log_remain_and_history_still_verifies(client, moderator, tombstone_schema):
    submission = StoredSubmission(state="listed")
    version = submissions.get_version(submission.version_cid)
    record_ids = [submission.paper_cid, version.manifest_cid, submission.version_cid, submission.consent["id"]]
    served_before = {cid: client.get(f"{RECORDS_URL}/{cid}").json() for cid in record_ids}
    entries_before = len(ledger.entries())
    decision = tombstone_decision(moderator, submission.version_cid)

    response = client.post(DECISIONS_URL, json=decision, headers=moderator.headers)

    assert response.status_code == 201, response.text
    # Every envelope is still served, byte for byte what it was...
    for cid, before in served_before.items():
        again = client.get(f"{RECORDS_URL}/{cid}")
        assert again.status_code == 200
        assert again.json() == before
    # ...and so is the decision that took the bytes down.
    assert client.get(f"{RECORDS_URL}/{decision['id']}").json()["body"]["action"] == "tombstone"
    # The log only grew: no entry was rewritten, so the hash chain still verifies.
    assert len(ledger.entries()) == entries_before + 1
    assert ledger.verify_log(ledger.entries()) is None
    # The signed records, which never covered the bytes, still check out.  An
    # authority's tombstone is a notice on a paper that verifies, not a failure.
    before = verify_paper([*submission.records, submission.consent], paper=submission.paper_cid)
    after = verify_paper(
        [*submission.records, submission.consent, decision],
        paper=submission.paper_cid,
        authorities=[moderator.did],
    )
    assert before.status == "verified", before.to_dict()
    assert after.valid, after.to_dict()
    assert after.status == "tombstoned"
    assert {name: check.passed for name, check in after.checks.items()} == dict.fromkeys(CHECK_NAMES, True)
    assert after.head == before.head == submission.version_cid


def test_the_export_leaves_out_the_tombstoned_bytes_but_keeps_the_records(client, moderator, tombstone_schema):
    submission = StoredSubmission(state="listed")
    export_url = f"/v1/export/paper/{submission.short_id}.car"
    exported = client.get(export_url)
    assert exported.status_code == 200, exported.text
    assert submission.manuscript in exported.content

    decision = tombstone_decision(moderator, submission.file_cid)
    assert client.post(DECISIONS_URL, json=decision, headers=moderator.headers).status_code == 201

    exported = client.get(export_url)
    assert exported.status_code == 200, exported.text
    assert submission.manuscript not in exported.content
    # The version record and the decision that named the file are still in it.
    assert submission.version_cid.encode() in exported.content
    assert decision["id"].encode() in exported.content


# --------------------------------------------------------------------------- #
# The schema the whole path depends on
# --------------------------------------------------------------------------- #


@pytest.mark.xfail(
    reason=(
        "shared edit pending: record-core's moderation.decision schema does not list "
        "'tombstone', so ingest refuses a tombstone before this plugin sees it"
    ),
    strict=False,
)
def test_the_shipped_schema_lists_every_action():
    document = json.loads((Path(schema_dir()) / "moderation.decision.json").read_text(encoding="utf-8"))

    assert set(document["properties"]["action"]["enum"]) == set(moderation.ACTIONS)
