"""Acceptance tests for: API exposes GET /v1/content/{cid}."""

import os

import pytest

from app.modules import content


def test_get_content_while_scanning_returns_423(client):
    data = os.urandom(64)
    blob = content.store_bytes(data)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 423


def test_get_content_when_passed_returns_200_with_csp_sandbox(client):
    data = os.urandom(64)
    blob = content.store_bytes(data, media_type="text/plain")
    content.set_scan_status(blob.cid, content.SCAN_PASSED)

    response = client.get(f"/v1/content/{blob.cid}")

    assert response.status_code == 200
    assert "sandbox" in response.headers.get("content-security-policy", "").lower()
    assert response.content == data