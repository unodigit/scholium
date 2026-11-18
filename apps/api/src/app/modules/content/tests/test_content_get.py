"""Tests for ``GET /v1/content/{cid}`` (feature 44).

The route serves stored bytes only for a blob the sanitizer passed, never
sets a cookie, and answers 423 while a scan is in flight and 451 for
content moderation removed.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import db
from app.main import app
from app.modules import content


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def unique_bytes(n: int = 64) -> bytes:
    return os.urandom(n)


def passed_blob(data: bytes, media_type: str | None = "text/plain"):
    blob = content.store_bytes(data, media_type=media_type)
    content.set_scan_status(blob.cid, content.SCAN_PASSED)
    return blob


def deny(cid: str, decision_cid: str = "test-decision") -> None:
    """Simulate the moderation plugin tombstoning ``cid``."""
    with db.engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE IF NOT EXISTS denylist (cid TEXT PRIMARY KEY, decision_cid TEXT NOT NULL)")
        )
        # ON CONFLICT ... DO UPDATE is the upsert both SQLite and PostgreSQL speak.
        connection.execute(
            text(
                "INSERT INTO denylist (cid, decision_cid) VALUES (:cid, :decision_cid) "
                "ON CONFLICT (cid) DO UPDATE SET decision_cid = excluded.decision_cid"
            ),
            {"cid": cid, "decision_cid": decision_cid},
        )


def test_scanning_blob_returns_423(client):
    blob = content.store_bytes(unique_bytes())

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 423
    assert response.content != b""
    assert response.headers["content-type"].startswith("application/problem+json")


def test_passed_blob_serves_bytes_with_security_headers(client):
    data = unique_bytes()
    blob = passed_blob(data)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 200
    assert response.content == data
    assert "sandbox" in response.headers["content-security-policy"].lower()
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "set-cookie" not in response.headers
    assert response.headers["content-type"].startswith("text/plain")


def test_media_type_is_optional_and_defaults_to_octet_stream(client):
    blob = passed_blob(unique_bytes(), media_type=None)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/octet-stream")


def test_foreign_media_type_cannot_inject_headers(client):
    # ``normalize_media_type`` rejects CR/LF, so a stored value can never
    # split the response headers.
    with pytest.raises(content.InvalidMediaType):
        content.store_bytes(unique_bytes(), media_type="text/plain\r\nSet-Cookie: x=1")


def test_failed_scan_returns_451(client):
    blob = content.store_bytes(unique_bytes())
    content.set_scan_status(blob.cid, content.SCAN_FAILED)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 451


def test_tombstoned_blob_returns_451_even_when_passed(client):
    blob = passed_blob(unique_bytes())
    deny(blob.cid)
    # The bytes may still be on disk in this unit test; the denylist wins.
    assert content.exists(blob.cid)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 451


def test_tombstoned_cid_returns_451_after_its_bytes_are_deleted(client, content_root):
    blob = passed_blob(unique_bytes())
    deny(blob.cid)
    (content_root / blob.cid).unlink()

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 451


def test_passed_row_without_bytes_returns_451(client, content_root):
    blob = passed_blob(unique_bytes())
    (content_root / blob.cid).unlink()

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 451


def test_unknown_cid_returns_404(client):
    from scholium_record_core import compute_file_id

    response = client.get(f"/v1/content/{compute_file_id(unique_bytes())}")

    assert response.status_code == 404


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-cid",
        "..%2F..%2Fetc%2Fpasswd",
        "bafkreiabc/../../x",
    ],
)
def test_malformed_cid_returns_404(client, bad):
    response = client.get(f"/v1/content/{bad}")

    assert response.status_code == 404


def test_served_response_has_no_set_cookie_even_on_errors(client):
    blob = content.store_bytes(unique_bytes())

    for path in (f"/v1/content/{blob.cid}", "/v1/content/not-a-cid"):
        assert "set-cookie" not in client.get(path).headers
