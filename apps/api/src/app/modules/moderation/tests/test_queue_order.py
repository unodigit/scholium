"""``GET /v1/moderation/queue`` lists versions oldest-arrival first, whatever the database.

The versions table has no timestamp, and an unordered ``SELECT`` is in heap
order on PostgreSQL -- which any ``UPDATE`` of a row changes -- where SQLite
happens to answer in insertion order. The queue is ordered by the ledger
sequence number each version's record was accepted at.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app import db
from app.main import app
from app.modules.content.tests.test_content_listing_gate import UnlistedPaper, _bearer
from app.modules.submissions.models import PaperVersion


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _queued(client, *papers: UnlistedPaper) -> list[str]:
    moderator = UnlistedPaper(state="listed").did
    response = client.get("/v1/moderation/queue", headers=_bearer(moderator, 4))
    assert response.status_code == 200, response.text
    mine = {paper.version_cid for paper in papers}
    return [entry["version_cid"] for entry in response.json() if entry["version_cid"] in mine]


def test_the_queue_is_in_arrival_order(client):
    first, second, third = (UnlistedPaper(state="moderation") for _ in range(3))

    assert _queued(client, first, second, third) == [first.version_cid, second.version_cid, third.version_cid]


def test_touching_a_row_does_not_move_it_in_the_queue(client):
    first, second, third = (UnlistedPaper(state="moderation") for _ in range(3))
    # Any UPDATE writes a new row version, which PostgreSQL then returns last.
    with db.SessionLocal() as session:
        session.execute(
            update(PaperVersion).where(PaperVersion.version_cid == first.version_cid).values(state="moderation")
        )
        session.commit()

    assert _queued(client, first, second, third) == [first.version_cid, second.version_cid, third.version_cid]
