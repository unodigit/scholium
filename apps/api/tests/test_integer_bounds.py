"""An integer no row can hold is "not found" on every dialect, never a server error.

SQLite compares any integer with an ``INTEGER`` column, so ``/v/99999999999``
is a 404 and ``from=99999999999`` an empty range. PostgreSQL's ``INTEGER`` is 32
bits, and SQLAlchemy casts the bound value to it, so the same request used to
fail with "integer out of range" and answer 500.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.modules.content.tests.test_content_listing_gate import UnlistedPaper, _bearer
from app.modules.ledger import service as ledger_service
from app.modules.notifications import service as notifications_service

BEYOND_32_BITS = 2**31
FAR_BEYOND = 99_999_999_999
BEYOND_64_BITS = 2**70


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture
def scene():
    paper = UnlistedPaper(state="listed")
    short_id = paper_short_id(paper)
    return paper, short_id


def paper_short_id(paper: UnlistedPaper) -> str:
    from app.modules import submissions

    version = submissions.get_version(paper.version_cid)
    return submissions.get_paper(version.paper_cid).short_id


@pytest.mark.parametrize("n", [BEYOND_32_BITS, FAR_BEYOND, BEYOND_64_BITS, -BEYOND_32_BITS - 1])
@pytest.mark.parametrize("suffix", ["annotations", "checks", "consents", "manifest", "text"])
def test_a_version_number_no_row_can_hold_is_a_404_not_a_500(client, scene, suffix, n):
    paper, short_id = scene

    response = client.get(f"/v1/papers/{short_id}/v/{n}/{suffix}", headers=_bearer(paper.did, 4))

    assert response.status_code < 500, response.text


@pytest.mark.parametrize("notification_id", [BEYOND_32_BITS, FAR_BEYOND, BEYOND_64_BITS])
def test_a_notification_id_no_row_can_hold_is_a_404_not_a_500(client, scene, notification_id):
    paper, _ = scene

    response = client.post(f"/v1/me/notifications/{notification_id}/read", headers=_bearer(paper.did, 1))

    assert response.status_code == 404, response.text


def test_the_sync_range_clamps_bounds_beyond_the_sequence_type(client, scene):
    head = ledger_service.latest().seq

    beyond_after = client.get(f"/v1/sync/range?from={FAR_BEYOND}")
    beyond_to = client.get(f"/v1/sync/range?from={head - 1}&to={FAR_BEYOND}")
    far_below = client.get(f"/v1/sync/range?from=0&to={FAR_BEYOND}&limit=2")

    assert beyond_after.status_code == 200 and beyond_after.json() == []
    assert beyond_to.status_code == 200 and [e["seq"] for e in beyond_to.json()] == [head]
    assert far_below.status_code == 200 and len(far_below.json()) == 2


def test_entries_treats_bounds_beyond_the_sequence_type_as_the_whole_or_none_of_the_log():
    head = ledger_service.latest().seq

    assert ledger_service.entries(after=BEYOND_64_BITS) == []
    assert ledger_service.entries(through=-BEYOND_64_BITS) == []
    assert [entry.seq for entry in ledger_service.entries(after=-BEYOND_64_BITS, through=BEYOND_64_BITS)][-1] == head


def test_marking_a_notification_beyond_the_id_type_finds_nothing():
    assert notifications_service.mark_read("did:key:z6MkNobody", BEYOND_64_BITS) is None
