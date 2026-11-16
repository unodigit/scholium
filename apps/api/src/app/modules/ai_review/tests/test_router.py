"""Tests for ``GET /v1/papers/{id}/ai-reviews`` (feature 122).

A paper, its version and its AI review are put in place through the same
plugin-level calls the submission handlers and the background job make, and
the route is then read with an anonymous client.  The acceptance suite covers
the spec's three criteria end to end; these tests pin the response's shape --
the advisory label, one group per specialist agent, evidence left intact --
and the ``404`` cases a reader can meet.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from scholium_record_core import compute_record_id, derive_short_id

from app import jobs
from app.main import create_app
from app.settings import settings
from nacl.signing import SigningKey
from app.modules import ai_review
from app.modules.ai_review import AGENT_NAMES, run_ai_review
from app.modules.ai_review.router import _group_by_agent
from app.modules.submissions import (
    VersionAuthor,
    save_paper,
    save_version,
    transition_version,
)

URL = "/v1/papers"


@pytest.fixture
def client():
    """An anonymous client over a freshly assembled app (all plugins loaded)."""
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture(autouse=True)
def _node_signing_key(tmp_path, monkeypatch):
    key = SigningKey.generate()
    path = tmp_path / "node.key"
    path.write_text(bytes(key).hex() + "\n")
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(path))


def _record_cid(tag: str, record_type: str) -> str:
    """A valid ``dag-cbor`` record id for a scene record."""
    return compute_record_id(
        {
            "v": 1,
            "type": record_type,
            "author": f"did:key:z{tag}",
            "created": "2026-01-01T00:00:00Z",
            "prev": None,
            "body": {"seed": tag},
            "proofs": [],
        }
    )


def _paper(*, list_it: bool = True) -> tuple[str, str]:
    """Create a paper and its first version; return ``(short_id, version_cid)``."""
    tag = uuid.uuid4().hex
    paper_cid = _record_cid(tag, "paper.genesis")
    save_paper(paper_cid=paper_cid, categories=("cs.CR",), licence="CC-BY-4.0")

    version_cid = _record_cid(tag, "paper.version")
    save_version(
        version_cid=version_cid,
        paper_cid=paper_cid,
        n=1,
        title=f"Router paper {tag}",
        abstract="A paper whose AI review readers can fetch.",
        manifest_cid=_record_cid(tag, "manifest"),
        licence="CC-BY-4.0",
        prev_cid=paper_cid,
        change_note="Version 1.",
        authors=(VersionAuthor(f"did:key:z{tag}", 1, ("Conceptualization",)),),
    )
    if list_it:
        for state in ("scanning", "moderation", "listed"):
            transition_version(version_cid, state)
    return derive_short_id(paper_cid), version_cid


def test_a_listed_paper_returns_its_advisory_report_grouped_by_agent(client):
    short_id, version_cid = _paper()
    run_ai_review(version_cid)

    body = client.get(f"{URL}/{short_id}/ai-reviews").json()

    assert body["advisory"] is True
    assert body["label"].startswith("Advisory.")
    assert [group["agent"] for group in body["agents"]] == list(AGENT_NAMES)
    for group in body["agents"]:
        for finding in group["findings"]:
            assert finding["agent"] == group["agent"]
            assert isinstance(finding["evidence"], dict) and finding["evidence"]


def test_the_version_id_resolves_to_the_same_report(client):
    short_id, version_cid = _paper()
    run_ai_review(version_cid)

    by_paper = client.get(f"{URL}/{short_id}/ai-reviews").json()
    by_version = client.get(f"{URL}/{short_id}/v1/ai-reviews").json()
    assert by_version["reviewCid"] == by_paper["reviewCid"]
    assert by_version["versionCid"] == version_cid


def test_an_unknown_id_answers_404(client):
    response = client.get(f"{URL}/sch:aaaa-bbbb-cccc/ai-reviews")
    assert response.status_code == 404


def test_a_listed_paper_with_no_review_yet_answers_404(client, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(jobs, "enqueue", lambda *args, **kwargs: None)
        short_id, _version_cid = _paper()
    response = client.get(f"{URL}/{short_id}/ai-reviews")
    assert response.status_code == 404
    assert "No AI pre-review" in response.json()["detail"]


def test_findings_are_grouped_by_agent_specialists_first():
    groups = _group_by_agent(
        [
            {"agent": "integrity", "claim": "c", "evidence": {"span": "s"}},
            {"agent": "future-agent", "claim": "d", "evidence": {"span": "s"}},
            {"claim": "no agent", "evidence": {"span": "s"}},
            "not a finding",
        ]
    )
    names = [group["agent"] for group in groups]
    assert names[: len(AGENT_NAMES)] == list(AGENT_NAMES)
    assert names[len(AGENT_NAMES):] == ["future-agent", "unknown"]
    assert groups[names.index("integrity")]["findings"][0]["claim"] == "c"


def test_reading_the_report_never_changes_the_paper_status(client):
    short_id, version_cid = _paper()
    run_ai_review(version_cid)
    before = client.get(f"{URL}/{short_id}").json()["status"]

    client.get(f"{URL}/{short_id}/ai-reviews")

    assert client.get(f"{URL}/{short_id}").json()["status"] == before
    assert ai_review.ADVISORY_LABEL == "Advisory. Generated by AI agents. Not a peer review."


def test_an_unsigned_fallback_report_is_never_served(client, monkeypatch):
    """A row left behind without a ledger record (an ``ai-review-...`` id from
    a failed signing attempt) must not reach a reader."""
    from app import db
    from app.modules.ai_review.models import AIReview, ensure_ai_reviews_table

    with monkeypatch.context() as patch:
        patch.setattr(jobs, "enqueue", lambda *args, **kwargs: None)
        short_id, version_cid = _paper()

    ensure_ai_reviews_table()
    with db.SessionLocal() as session:
        session.add(
            AIReview(
                review_cid=f"ai-review-{version_cid}-deadbeef",
                version_cid=version_cid,
                models=[{"name": "fake", "provider": "fake"}],
                prompt_set_hash="0" * 64,
                findings=[],
            )
        )
        session.commit()

    response = client.get(f"{URL}/{short_id}/ai-reviews")

    assert response.status_code == 404, response.text
    assert "No AI pre-review" in response.json()["detail"]


def test_the_pipeline_receives_the_versions_code_bundle(monkeypatch):
    """The reproducibility sandbox needs the manifest's ``code`` file, not
    only the manuscript, or it silently never runs."""
    from types import SimpleNamespace

    from app.modules import ledger
    from app.modules.ai_review import background

    with monkeypatch.context() as patch:
        patch.setattr(jobs, "enqueue", lambda *args, **kwargs: None)
        _short_id, version_cid = _paper()

    seen: dict[str, object] = {}

    def fake_pipeline(version_cid, *, pdf_cid=None, bundle_cid=None, listed=True):
        seen["bundle_cid"] = bundle_cid
        return [], [], "0" * 64, []

    manifest_body = {
        "files": [
            {"role": "manuscript", "cid": "bafy-manuscript"},
            {"role": "code", "cid": "bafy-code-bundle"},
        ]
    }
    monkeypatch.setattr(background, "_run_pipeline", fake_pipeline)
    monkeypatch.setattr(ledger, "entry_by_cid", lambda cid: object())
    monkeypatch.setattr(
        ledger, "stored_envelope", lambda entry: SimpleNamespace(body=manifest_body)
    )

    background.run_ai_review(version_cid)

    assert seen["bundle_cid"] == "bafy-code-bundle"

