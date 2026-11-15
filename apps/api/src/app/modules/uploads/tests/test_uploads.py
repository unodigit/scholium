"""Tests for tus 1.0.0 upload creation (feature: uploads 45).

Covers: the 201 + Location creation success, the tus version handshake
(412), length validation (400), the 50 MiB PDF and 5 GiB bundle limits
rendered as 413 problem details, metadata parsing (base64 and raw
values, tus-js-client's ``filetype`` key), the OPTIONS discovery
endpoint, and the persistence of the created upload.
"""

import base64

import pytest

from app.modules.uploads import limits

TUS_HEADERS = {"Tus-Resumable": "1.0.0"}

PDF_LIMIT = limits.PDF_MAX_BYTES  # 50 MiB
BUNDLE_LIMIT = limits.BUNDLE_MAX_BYTES  # 5 GiB


def b64(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def create(client, headers=None):
    """POST a tus creation request with the Tus-Resumable header applied."""
    return client.post("/v1/uploads", headers={**TUS_HEADERS, **(headers or {})})


# --- creation success ---------------------------------------------------------


def test_creation_returns_201_with_location(client):
    response = create(
        client,
        headers={
            "Upload-Length": "1024",
            "Upload-Metadata": f"filename {b64('paper.pdf')},filetype {b64('application/pdf')}",
        },
    )
    assert response.status_code == 201
    location = response.headers["location"]
    assert location.startswith("/v1/uploads/")
    assert len(location.rsplit("/", 1)[1]) > 0
    assert response.headers["tus-resumable"] == "1.0.0"


def test_creation_stores_the_upload(client):
    from app.db import SessionLocal
    from app.modules.uploads.store import get_upload

    response = create(client, headers={"Upload-Length": "2048"})
    assert response.status_code == 201
    upload_id = response.headers["location"].rsplit("/", 1)[1]

    session = SessionLocal()
    try:
        upload = get_upload(session, upload_id)
        assert upload is not None
        assert upload.upload_length == 2048
        assert upload.upload_offset == 0
        assert upload.state == "pending"
    finally:
        session.close()


def test_creation_without_metadata_succeeds(client):
    response = create(client, headers={"Upload-Length": "10"})
    assert response.status_code == 201
    assert "location" in response.headers


def test_creation_with_deferred_length_succeeds(client):
    response = create(client, headers={"Upload-Defer-Length": "1"})
    assert response.status_code == 201
    assert "location" in response.headers


def test_creation_records_authenticated_owner(client):
    from app.db import SessionLocal
    from app.modules.uploads.store import get_upload
    from app.security import issue_access_token

    token = issue_access_token("did:key:z6MkAuthor", 2)
    response = create(client, headers={"Upload-Length": "10", "Authorization": f"Bearer {token}"})
    assert response.status_code == 201
    upload_id = response.headers["location"].rsplit("/", 1)[1]

    session = SessionLocal()
    try:
        upload = get_upload(session, upload_id)
        assert upload.owner_did == "did:key:z6MkAuthor"
    finally:
        session.close()


def test_two_creations_get_distinct_locations(client):
    first = create(client, headers={"Upload-Length": "1"})
    second = create(client, headers={"Upload-Length": "1"})
    assert first.status_code == second.status_code == 201
    assert first.headers["location"] != second.headers["location"]


# --- 413 problem details: PDF over 50 MiB -------------------------------------


def test_pdf_over_50_mib_rejected_with_413_problem_details(client):
    response = create(
        client,
        headers={
            "Upload-Length": str(PDF_LIMIT + 1),
            "Upload-Metadata": f"filetype {b64('application/pdf')}",
        },
    )
    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 413
    assert body["title"] == "Payload Too Large"
    assert body["detail"]
    assert body["instance"] == "/v1/uploads"
    assert "location" not in response.headers


def test_pdf_exactly_at_the_limit_is_accepted(client):
    response = create(
        client,
        headers={
            "Upload-Length": str(PDF_LIMIT),
            "Upload-Metadata": f"filetype {b64('application/pdf')}",
        },
    )
    assert response.status_code == 201


def test_pdf_over_limit_detected_from_filename_extension(client):
    response = create(
        client,
        headers={
            "Upload-Length": "60000000",
            "Upload-Metadata": f"filename {b64('preprint.pdf')}",
        },
    )
    assert response.status_code == 413
    assert response.json()["status"] == 413


def test_pdf_over_limit_detected_from_raw_metadata(client):
    """A client that skipped base64-encoding still names a PDF correctly."""
    response = create(
        client,
        headers={"Upload-Length": "60000000", "Upload-Metadata": "type application/pdf"},
    )
    assert response.status_code == 413


def test_pdf_over_limit_detected_from_request_content_type(client):
    response = create(
        client,
        headers={"Upload-Length": "60000000", "Content-Type": "application/pdf"},
    )
    assert response.status_code == 413


def test_pdf_over_limit_detected_from_kind_metadata(client):
    response = create(
        client,
        headers={"Upload-Length": "60000000", "Upload-Metadata": f"kind {b64('pdf')}"},
    )
    assert response.status_code == 413


# --- 413 problem details: bundle over 5 GiB -----------------------------------


def test_bundle_over_5_gib_rejected_with_413_problem_details(client):
    response = create(
        client,
        headers={
            "Upload-Length": str(BUNDLE_LIMIT + 1),
            "Upload-Metadata": f"filetype {b64('application/zip')}",
        },
    )
    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 413
    assert body["title"] == "Payload Too Large"
    assert body["detail"]


def test_bundle_exactly_at_the_limit_is_accepted(client):
    response = create(
        client,
        headers={
            "Upload-Length": str(BUNDLE_LIMIT),
            "Upload-Metadata": f"filename {b64('code-and-data.tar.gz')}",
        },
    )
    assert response.status_code == 201


def test_bundle_over_limit_detected_from_request_content_type(client):
    response = create(
        client,
        headers={"Upload-Length": str(BUNDLE_LIMIT + 1), "Content-Type": "application/zip"},
    )
    assert response.status_code == 413


def test_unclassified_upload_over_5_gib_is_rejected(client):
    """Without any kind signal, the 5 GiB global cap still applies."""
    response = create(client, headers={"Upload-Length": str(BUNDLE_LIMIT + 1)})
    assert response.status_code == 413


def test_small_bundle_and_small_pdf_both_accepted(client):
    bundle = create(
        client,
        headers={"Upload-Length": "1048576", "Upload-Metadata": f"filetype {b64('application/zip')}"},
    )
    pdf = create(
        client,
        headers={"Upload-Length": "1048576", "Upload-Metadata": f"filetype {b64('application/pdf')}"},
    )
    assert bundle.status_code == 201
    assert pdf.status_code == 201


# --- protocol validation ------------------------------------------------------


def test_wrong_tus_version_rejected_with_412(client):
    response = client.post("/v1/uploads", headers={"Tus-Resumable": "0.2.2", "Upload-Length": "10"})
    assert response.status_code == 412
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["status"] == 412
    assert response.headers.get("tus-version") == "1.0.0"


def test_missing_tus_version_rejected_with_412(client):
    response = client.post("/v1/uploads", headers={"Upload-Length": "10"})
    assert response.status_code == 412


@pytest.mark.parametrize(
    "length",
    ["-1", "12.5", "1e3", "ten", ""],
)
def test_invalid_upload_length_rejected_with_400(client, length):
    response = create(client, headers={"Upload-Length": length})
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/problem+json")


def test_missing_length_and_defer_length_rejected_with_400(client):
    response = create(client, headers={})
    assert response.status_code == 400
    body = response.json()
    assert body["status"] == 400
    assert "Upload-Length" in body["detail"]


def test_length_and_defer_length_together_rejected_with_400(client):
    response = create(client, headers={"Upload-Length": "10", "Upload-Defer-Length": "1"})
    assert response.status_code == 400


def test_defer_length_must_be_one(client):
    response = create(client, headers={"Upload-Defer-Length": "2"})
    assert response.status_code == 400


# --- tus discovery ------------------------------------------------------------


def test_options_advertises_tus_creation():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        response = client.options("/v1/uploads")
    assert response.status_code == 204
    assert response.headers["tus-resumable"] == "1.0.0"
    assert response.headers["tus-version"] == "1.0.0"
    assert "creation" in response.headers["tus-extension"]
    assert int(response.headers["tus-max-size"]) == BUNDLE_LIMIT


# --- pure limit/metadata logic ------------------------------------------------


def test_limits_use_binary_units():
    assert limits.PDF_MAX_BYTES == 50 * 1024 * 1024
    assert limits.BUNDLE_MAX_BYTES == 5 * 1024**3


def test_parse_upload_metadata_decodes_base64_and_raw():
    header = f"filename {b64('paper.pdf')},type application/pdf,is_final false"
    parsed = limits.parse_upload_metadata(header)
    assert parsed["filename"] == "paper.pdf"
    assert parsed["type"] == "application/pdf"
    assert parsed["is_final"] == "false"


def test_parse_upload_metadata_tolerates_junk():
    assert limits.parse_upload_metadata("") == {}
    assert limits.parse_upload_metadata(None) == {}
    assert limits.parse_upload_metadata("filename") == {"filename": ""}
    assert limits.parse_upload_metadata("a b,c d,") == {"a": "b", "c": "d"}


@pytest.mark.parametrize(
    ("metadata", "content_type", "expected"),
    [
        ({"filetype": "application/pdf"}, None, "pdf"),
        ({"type": "application/pdf"}, None, "pdf"),
        ({"kind": "pdf"}, None, "pdf"),
        ({"filename": "thesis.pdf"}, None, "pdf"),
        ({"filename": "source.tar.gz"}, None, "bundle"),
        ({"filename": "data.zip"}, None, "bundle"),
        ({"filetype": "application/zip"}, None, "bundle"),
        ({"filetype": "application/gzip"}, None, "bundle"),
        ({"kind": "bundle"}, None, "bundle"),
        ({}, "application/pdf", "pdf"),
        ({}, "application/x-tar", "bundle"),
        ({}, "application/offset+octet-stream", "other"),
        ({}, None, "other"),
    ],
)
def test_classify_upload(metadata, content_type, expected):
    assert limits.classify_upload(metadata, content_type=content_type) == expected


def test_pdf_hint_wins_over_bundle_hint():
    """A PDF that also claims to be an archive gets the stricter limit."""
    assert limits.classify_upload({"filetype": "application/zip", "name": "paper.pdf"}) == "pdf"


def test_check_upload_length_is_strictly_greater():
    assert limits.check_upload_length(limits.PDF_MAX_BYTES, "pdf") is None
    assert limits.check_upload_length(limits.PDF_MAX_BYTES + 1, "pdf") == limits.PDF_MAX_BYTES
    assert limits.check_upload_length(limits.BUNDLE_MAX_BYTES + 1, "bundle") == limits.BUNDLE_MAX_BYTES
    assert limits.check_upload_length(10**13, "other") == limits.BUNDLE_MAX_BYTES
