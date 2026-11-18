"""Regression: the panel-not-formed notice counts eligible members correctly.

The notice used to say "only 2 of the 3 eligible members are available", which
reads as three eligible members of whom two are free.  What is meant is that two
eligible members exist and a panel needs three.

This lives with the recovery tests only because that is the test directory this
fix owns; the subject is :func:`app.modules.appeals.service.notify_panel_missing`.
It needs no database: the audience lookup and the notifier are replaced.
"""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from typing import Any

import pytest

from app.modules.appeals import service as appeals_service
from app.modules.notifications import service as notifications_service


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Every payload ``notify_panel_missing`` hands the notifier."""
    payloads: list[dict[str, Any]] = []

    def fake_notify(did: str, kind: str, payload: dict[str, Any]) -> None:
        payloads.append(payload)

    def no_decision(target: str) -> None:
        raise LookupError(target)

    monkeypatch.setattr(notifications_service, "notify", fake_notify)
    monkeypatch.setattr(appeals_service, "_tier_four_dids", lambda: [])
    monkeypatch.setattr(appeals_service, "resolve_decision", no_decision)
    return payloads


def _summary(sent: list[dict[str, Any]], *, eligible: int, needed: int = 3) -> str:
    appeal = SimpleNamespace(
        appeal_cid="bafyappeal",
        decision_cid="bafydecision",
        appellant_did="did:key:z6Mkappellant",
        filed_at=datetime(2026, 11, 18, 9, 0, 0),
        status="not_formed",
    )
    assert appeals_service.notify_panel_missing(appeal, None, eligible=eligible, needed=needed) == 1
    assert len(sent) == 1
    return sent[0]["summary"]


def test_two_eligible_members_and_a_panel_of_three_reads_as_exactly_that(sent):
    summary = _summary(sent, eligible=2)

    assert "Only 2 eligible members are available; a panel needs 3." in summary
    assert "of the 3 eligible" not in summary
    # The same sentence is the reader-facing outcome as well as the summary.
    assert sent[0]["outcome"] == summary


def test_one_eligible_member_is_singular(sent):
    summary = _summary(sent, eligible=1)

    assert "Only 1 eligible member is available; a panel needs 3." in summary


def test_no_eligible_members_says_none_rather_than_only_zero(sent):
    summary = _summary(sent, eligible=0)

    assert "No eligible members are available; a panel needs 3." in summary
    assert "Only 0" not in summary
