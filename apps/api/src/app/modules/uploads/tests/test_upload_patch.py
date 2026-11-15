"""Tests for tus 1.0.0 resumable uploads: PATCH and HEAD (feature: uploads 46).

Covers: appending at ``Upload-Offset`` (204 + the new offset), HEAD reporting
the received offset, the 409 on an offset mismatch (and that a refused PATCH
changes nothing), the header validation (412/415/400/404), the declared length
(overflow is a 413 that rolls back, a deferred length is learned from a PATCH,
completion), and the resilience the feature exists for: bytes that arrive
before a connection drops are kept, bytes a crashed request left behind are
discarded, and two writers cannot interleave.
"""

import asyncio
import hashlib

import pytest

from app.modules.uploads import limits, store

TUS_HEADERS = {"Tus-Resumable": "1.0.0"}
OFFSET_CONTENT_TYPE = "application/offset+octet-stream"


def create(client, length=1024, **headers) -> str:
    """Create an upload of ``length`` bytes (or a deferred one) and return its id."""
    request_headers = {**TUS_HEADERS, **headers}
    if length is not None:
        request_headers["Upload-Length"] = str(length)
    response = client.post("/v1/uploads", headers=request_headers)
    assert response.status_code == 201, response.text
    return response.headers["location"].rsplit("/", 1)[1]


def patch(client, upload_id, offset, data=b"", **headers):
    """PATCH ``data`` at ``offset``; ``headers`` override the defaults (None drops one)."""
    request_headers = {
        **TUS_HEADERS,
        "Upload-Offset": str(offset),
        "Content-Type": OFFSET_CONTENT_TYPE,
        **headers,
    }
    request_headers = {k: v for k, v in request_headers.items() if v is not None}
    return client.patch(f"/v1/uploads/{upload_id}", content=data, headers=request_headers)


def head(client, upload_id):
    return client.head(f"/v1/uploads/{upload_id}", headers=TUS_HEADERS)


def offset_of(response) -> int:
    return int(response.headers["upload-offset"])


def staged_bytes(upload_id) -> bytes:
    return store.staged_path(upload_id).read_bytes()


def stored_upload(upload_id):
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        return store.get_upload(session, upload_id)
    finally:
        session.close()


# --- PATCH appends ------------------------------------------------------------


def test_patch_answers_204_with_the_new_offset(client):
    upload_id = create(client)
    response = patch(client, upload_id, 0, b"hello")
    assert response.status_code == 204
    assert response.content == b""
    assert response.headers["tus-resumable"] == "1.0.0"
    assert offset_of(response) == 5


def test_successive_patches_append_in_order(client):
    upload_id = create(client)
    first = patch(client, upload_id, 0, b"abc")
    second = patch(client, upload_id, offset_of(first), b"defg")
    assert offset_of(second) == 7
    assert staged_bytes(upload_id) == b"abcdefg"
    assert stored_upload(upload_id).upload_offset == 7


def test_a_large_body_is_written_whole(client):
    data = bytes(range(256)) * 12_000  # ~3 MiB: arrives in many ASGI chunks
    upload_id = create(client, length=len(data))
    response = patch(client, upload_id, 0, data)
    assert response.status_code == 204
    assert offset_of(response) == len(data)
    assert hashlib.sha256(staged_bytes(upload_id)).digest() == hashlib.sha256(data).digest()


def test_an_empty_patch_at_the_current_offset_is_a_no_op(client):
    upload_id = create(client)
    patch(client, upload_id, 0, b"abc")
    response = patch(client, upload_id, 3, b"")
    assert response.status_code == 204
    assert offset_of(response) == 3
    assert staged_bytes(upload_id) == b"abc"


def test_content_type_parameters_are_tolerated(client):
    upload_id = create(client)
    response = patch(client, upload_id, 0, b"abc", **{"Content-Type": f"{OFFSET_CONTENT_TYPE}; charset=binary"})
    assert response.status_code == 204


# --- HEAD ---------------------------------------------------------------------


def test_head_of_a_fresh_upload_reports_offset_zero(client):
    upload_id = create(client, length=100)
    response = head(client, upload_id)
    assert response.status_code == 200
    assert response.content == b""
    assert offset_of(response) == 0
    assert response.headers["upload-length"] == "100"
    assert response.headers["tus-resumable"] == "1.0.0"


def test_head_is_never_cacheable(client):
    upload_id = create(client)
    assert head(client, upload_id).headers["cache-control"] == "no-store"


def test_head_tracks_each_patch(client):
    upload_id = create(client)
    patch(client, upload_id, 0, b"abcd")
    assert offset_of(head(client, upload_id)) == 4
    patch(client, upload_id, 4, b"ef")
    assert offset_of(head(client, upload_id)) == 6


def test_head_echoes_the_creation_metadata(client):
    upload_id = create(client, **{"Upload-Metadata": "filename cGFwZXIucGRm"})
    assert head(client, upload_id).headers["upload-metadata"] == "filename cGFwZXIucGRm"


def test_head_of_a_deferred_length_upload_says_the_length_is_deferred(client):
    upload_id = create(client, length=None, **{"Upload-Defer-Length": "1"})
    response = head(client, upload_id)
    assert response.status_code == 200
    assert response.headers["upload-defer-length"] == "1"
    assert "upload-length" not in response.headers


def test_head_of_an_unknown_upload_is_404(client):
    response = client.head("/v1/uploads/no-such-upload", headers=TUS_HEADERS)
    assert response.status_code == 404
    assert response.headers["tus-resumable"] == "1.0.0"


@pytest.mark.parametrize("version", [None, "0.2.2", "2.0.0"])
def test_head_without_tus_1_0_0_is_412(client, version):
    upload_id = create(client)
    headers = {} if version is None else {"Tus-Resumable": version}
    response = client.head(f"/v1/uploads/{upload_id}", headers=headers)
    assert response.status_code == 412
    assert response.headers["tus-version"] == "1.0.0"


# --- 409 on an offset mismatch ------------------------------------------------


def test_patch_behind_the_offset_is_409_and_changes_nothing(client):
    upload_id = create(client)
    patch(client, upload_id, 0, b"abcdef")

    response = patch(client, upload_id, 0, b"XXXXXX")

    assert response.status_code == 409
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 409
    assert body["type"] == "urn:scholium:problem:upload-offset-mismatch"
    assert "6" in body["detail"]
    assert offset_of(response) == 6  # where to continue, without a HEAD
    assert staged_bytes(upload_id) == b"abcdef"
    assert offset_of(head(client, upload_id)) == 6


def test_patch_ahead_of_the_offset_is_409_and_creates_no_gap(client):
    upload_id = create(client)
    patch(client, upload_id, 0, b"abc")

    response = patch(client, upload_id, 10, b"gap")

    assert response.status_code == 409
    assert offset_of(response) == 3
    assert staged_bytes(upload_id) == b"abc"


def test_a_resumed_upload_continues_from_the_reported_offset(client):
    upload_id = create(client, length=10)
    patch(client, upload_id, 0, b"01234")
    # The client lost the response; it asks, then continues where the server is.
    resume_at = offset_of(head(client, upload_id))
    assert patch(client, upload_id, resume_at, b"56789").status_code == 204
    assert staged_bytes(upload_id) == b"0123456789"


# --- header validation --------------------------------------------------------


def test_patch_to_an_unknown_upload_is_404_and_stages_nothing(client):
    response = patch(client, "no-such-upload", 0, b"abc")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert not store.staged_path("no-such-upload").exists()


@pytest.mark.parametrize("version", [None, "0.2.2"])
def test_patch_without_tus_1_0_0_is_412(client, version):
    upload_id = create(client)
    response = patch(client, upload_id, 0, b"abc", **{"Tus-Resumable": version})
    assert response.status_code == 412
    assert response.headers["tus-version"] == "1.0.0"
    assert staged_bytes_or_empty(upload_id) == b""


@pytest.mark.parametrize("content_type", [None, "application/octet-stream", "application/json", "text/plain"])
def test_patch_needs_the_offset_content_type(client, content_type):
    upload_id = create(client)
    response = patch(client, upload_id, 0, b"abc", **{"Content-Type": content_type})
    assert response.status_code == 415
    assert response.headers["content-type"].startswith("application/problem+json")
    assert offset_of(head(client, upload_id)) == 0


def test_patch_without_an_offset_is_400(client):
    upload_id = create(client)
    response = patch(client, upload_id, 0, b"abc", **{"Upload-Offset": None})
    assert response.status_code == 400
    assert "Upload-Offset" in response.json()["detail"]


@pytest.mark.parametrize("offset", ["-1", "abc", "1.5", "1e3", "", " ", "9" * 40, "0x10"])
def test_patch_with_a_malformed_offset_is_400(client, offset):
    upload_id = create(client)
    response = patch(client, upload_id, 0, b"abc", **{"Upload-Offset": offset})
    assert response.status_code == 400
    assert offset_of(head(client, upload_id)) == 0


def staged_bytes_or_empty(upload_id) -> bytes:
    path = store.staged_path(upload_id)
    return path.read_bytes() if path.exists() else b""


# --- declared length ----------------------------------------------------------


def test_the_upload_completes_when_the_last_byte_arrives(client):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")
    assert stored_upload(upload_id).state == "pending"
    patch(client, upload_id, 3, b"def")
    assert stored_upload(upload_id).state == "completed"
    assert staged_bytes(upload_id) == b"abcdef"


def test_a_body_past_the_declared_length_is_413_and_changes_nothing(client):
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")

    response = patch(client, upload_id, 3, b"defgh")

    assert response.status_code == 413
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "urn:scholium:problem:upload-too-large"
    assert offset_of(head(client, upload_id)) == 3
    assert staged_bytes(upload_id) == b"abc"


def test_an_overflowing_body_without_a_content_length_is_413_and_rolls_back(client):
    """A chunked body only overflows mid-stream: what was written so far must go."""
    upload_id = create(client, length=6)
    patch(client, upload_id, 0, b"abc")

    def body():
        yield b"de"
        yield b"fgh"  # takes the upload to 8 bytes of 6

    response = patch(client, upload_id, 3, body())

    assert response.status_code == 413
    assert offset_of(head(client, upload_id)) == 3
    assert staged_bytes(upload_id) == b"abc"
    assert stored_upload(upload_id).state == "pending"


def test_patching_a_completed_upload_is_413(client):
    upload_id = create(client, length=3)
    patch(client, upload_id, 0, b"abc")
    assert patch(client, upload_id, 3, b"d").status_code == 413
    assert staged_bytes(upload_id) == b"abc"


def test_a_deferred_length_is_learned_from_a_patch(client):
    upload_id = create(client, length=None, **{"Upload-Defer-Length": "1"})

    first = patch(client, upload_id, 0, b"abc", **{"Upload-Length": "6"})
    assert first.status_code == 204
    after_first = head(client, upload_id)
    assert after_first.headers["upload-length"] == "6"
    assert "upload-defer-length" not in after_first.headers

    patch(client, upload_id, 3, b"def")
    assert stored_upload(upload_id).state == "completed"
    assert staged_bytes(upload_id) == b"abcdef"


def test_a_deferred_upload_without_a_length_accepts_bytes_and_stays_pending(client):
    upload_id = create(client, length=None, **{"Upload-Defer-Length": "1"})
    assert patch(client, upload_id, 0, b"abc").status_code == 204
    assert stored_upload(upload_id).state == "pending"


def test_a_deferred_length_over_the_limit_for_its_kind_is_413(client):
    upload_id = create(
        client,
        length=None,
        **{"Upload-Defer-Length": "1", "Upload-Metadata": "filetype YXBwbGljYXRpb24vcGRm"},  # application/pdf
    )
    response = patch(client, upload_id, 0, b"abc", **{"Upload-Length": str(limits.PDF_MAX_BYTES + 1)})
    assert response.status_code == 413
    assert offset_of(head(client, upload_id)) == 0
    assert stored_upload(upload_id).upload_length is None


def test_a_deferred_length_below_what_was_received_is_400(client):
    upload_id = create(client, length=None, **{"Upload-Defer-Length": "1"})
    patch(client, upload_id, 0, b"abcde")
    response = patch(client, upload_id, 5, b"", **{"Upload-Length": "3"})
    assert response.status_code == 400
    assert stored_upload(upload_id).upload_length is None


def test_a_known_length_cannot_be_changed_by_a_patch(client):
    upload_id = create(client, length=10)
    assert patch(client, upload_id, 0, b"abc", **{"Upload-Length": "11"}).status_code == 400
    assert offset_of(head(client, upload_id)) == 0
    # Restating the same length is harmless.
    assert patch(client, upload_id, 0, b"abc", **{"Upload-Length": "10"}).status_code == 204


def test_options_advertises_deferred_length_creation(client):
    response = client.options("/v1/uploads")
    extensions = response.headers["tus-extension"].split(",")
    assert "creation" in extensions
    assert "creation-defer-length" in extensions


# --- resilience ---------------------------------------------------------------


def run_patch_over_asgi(upload_id, offset, messages):
    """Drive PATCH through the ASGI app with a scripted request, TestClient can't drop a body.

    ``offset`` may be raw ``bytes``: TestClient re-encodes header values, so only a scripted
    request can put an exact byte on the wire.
    """
    from app.main import app as asgi_app

    sent = []
    queue = list(messages)

    async def receive():
        return queue.pop(0)

    async def send(message):
        sent.append(message)

    path = f"/v1/uploads/{upload_id}"
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "PATCH",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [
            (b"tus-resumable", b"1.0.0"),
            (b"upload-offset", offset if isinstance(offset, bytes) else str(offset).encode()),
            (b"content-type", OFFSET_CONTENT_TYPE.encode()),
        ],
        "client": ("testclient", 5000),
        "server": ("testserver", 80),
    }
    asyncio.run(asgi_app(scope, receive, send))
    return next(m["status"] for m in sent if m["type"] == "http.response.start")


def test_bytes_received_before_a_dropped_connection_are_kept(client):
    """The point of resumable uploads: an interrupted PATCH is not lost work."""
    upload_id = create(client)
    patch(client, upload_id, 0, b"head-")

    run_patch_over_asgi(
        upload_id,
        5,
        [
            {"type": "http.request", "body": b"half ", "more_body": True},
            {"type": "http.request", "body": b"sent", "more_body": True},
            {"type": "http.disconnect"},
        ],
    )

    resumed_at = offset_of(head(client, upload_id))
    assert resumed_at == len(b"head-half sent")
    assert patch(client, upload_id, resumed_at, b"-tail").status_code == 204
    assert staged_bytes(upload_id) == b"head-half sent-tail"


def test_a_unicode_digit_offset_is_400_not_a_crash(client):
    """``'²'.isdigit()`` is true but ``int('²')`` raises: that must not become a 500.

    Servers decode header bytes as latin-1, so the single byte 0xB2 reaches the route as '²'.
    """
    upload_id = create(client)
    status = run_patch_over_asgi(
        upload_id, b"\xb2", [{"type": "http.request", "body": b"abc", "more_body": False}]
    )
    assert status == 400
    assert offset_of(head(client, upload_id)) == 0


def test_bytes_a_crashed_request_left_past_the_offset_are_discarded(client):
    """The file got bytes but the database never heard of them: they were never acknowledged."""
    upload_id = create(client)
    patch(client, upload_id, 0, b"abcdef")
    with open(store.staged_path(upload_id), "ab") as leftover:
        leftover.write(b"JUNK")

    assert offset_of(head(client, upload_id)) == 6
    assert patch(client, upload_id, 6, b"ghi").status_code == 204
    assert staged_bytes(upload_id) == b"abcdefghi"


def test_an_upload_whose_acknowledged_bytes_are_gone_is_410(client):
    upload_id = create(client)
    patch(client, upload_id, 0, b"abcdef")
    store.staged_path(upload_id).write_bytes(b"ab")

    response = patch(client, upload_id, 6, b"ghi")

    assert response.status_code == 410
    assert offset_of(head(client, upload_id)) == 6  # the record is untouched


def test_a_second_writer_is_told_to_retry_while_one_holds_the_upload(client):
    upload_id = create(client)
    held = store.open_staged(upload_id)
    try:
        response = patch(client, upload_id, 0, b"abc")
        assert response.status_code == 423
        assert response.json()["type"] == "urn:scholium:problem:upload-locked"
    finally:
        held.close()

    assert patch(client, upload_id, 0, b"abc").status_code == 204
    assert staged_bytes(upload_id) == b"abc"


# --- store --------------------------------------------------------------------


def test_advance_offset_is_a_compare_and_swap(client):
    from app.db import SessionLocal

    upload_id = create(client, length=10)
    session = SessionLocal()
    try:
        assert store.advance_offset(session, upload_id, expected_offset=0, new_offset=4)
        # A writer that read the offset before that update must lose.
        assert not store.advance_offset(session, upload_id, expected_offset=0, new_offset=7)
    finally:
        session.close()
    assert stored_upload(upload_id).upload_offset == 4


def test_advance_offset_ignores_an_unknown_upload(client):
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        assert not store.advance_offset(session, "no-such-upload", expected_offset=0, new_offset=1)
    finally:
        session.close()


@pytest.mark.parametrize("upload_id", ["../escape", "a/b", "", "a" * 65, "x y", "..", "dot.ted"])
def test_staged_path_refuses_ids_that_could_leave_the_staging_directory(upload_id):
    with pytest.raises(ValueError):
        store.staged_path(upload_id)


def test_staged_bytes_live_under_the_content_dir(client, content_root):
    upload_id = create(client)
    patch(client, upload_id, 0, b"abc")
    assert store.staged_path(upload_id) == content_root / ".uploads" / upload_id
