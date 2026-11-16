"""Acceptance tests for: PATCH/HEAD /v1/uploads/{id} (feature 46).

The uploads plugin already speaks tus 1.0.0 for creation
(``POST /v1/uploads`` answers ``201 Created`` with a ``Location`` of
``/v1/uploads/{id}``).  This feature adds the resumable half of tus core:

* ``PATCH /v1/uploads/{id}`` appends the request body at the byte offset
  named by the ``Upload-Offset`` header, answering ``204 No Content``;
* ``HEAD /v1/uploads/{id}`` reports the bytes received so far in the
  ``Upload-Offset`` response header;
* a ``PATCH`` whose ``Upload-Offset`` does not match the server's current
  offset is a ``409 Conflict``, so an interrupted upload resumes from the
  right place instead of silently corrupting the file.

Criteria (app_spec.xml, feature 46):

* HEAD /v1/uploads/{id} after a partial PATCH returns the received
  Upload-Offset.
* PATCH /v1/uploads/{id} with a wrong Upload-Offset returns 409.

Only what the criteria state is asserted: the statuses those operations
need under tus 1.0.0 and the ``Upload-Offset`` header.  Nothing else about
the response (body fields, completion state, or the later move into the
content store) is pinned here.
"""

from __future__ import annotations

from app.security import issue_access_token

#: Creating, inspecting and appending to an upload all need an authenticated
#: member (tier 1 or above), and the upload belongs to the DID the token names.
#: Every request below therefore carries the same caller's bearer token.
AUTH_HEADERS = {"Authorization": f"Bearer {issue_access_token('did:key:z6MkUploadAcceptance', 1)}"}

#: Every tus request carries the protocol version; the uploads plugin
#: already rejects anything but 1.0.0 with 412.
TUS_HEADERS = {**AUTH_HEADERS, "Tus-Resumable": "1.0.0"}

#: The media type tus 1.0.0 requires on a PATCH carrying bytes.
OFFSET_CONTENT_TYPE = "application/offset+octet-stream"

#: Statuses that count as "the PATCH succeeded" for the preconditions here.
#: tus 1.0.0 mandates 204 No Content; 200 is tolerated so this suite tests
#: offsets rather than re-litigating the success code.
PATCH_OK = (200, 204)


def create_upload(client, length: int) -> str:
    """Create a tus upload of ``length`` bytes and return its resource URL."""
    response = client.post(
        "/v1/uploads",
        headers={**TUS_HEADERS, "Upload-Length": str(length)},
    )
    assert response.status_code == 201, response.text
    location = response.headers.get("location")
    assert location, "creation did not return a Location header"
    return location


def patch_bytes(client, upload_url: str, offset: int, data: bytes):
    """Send ``data`` to ``upload_url`` as the chunk starting at ``offset``."""
    return client.patch(
        upload_url,
        content=data,
        headers={
            **TUS_HEADERS,
            "Upload-Offset": str(offset),
            "Content-Type": OFFSET_CONTENT_TYPE,
        },
    )


def received_offset(response) -> int:
    """The ``Upload-Offset`` response header as an integer."""
    value = response.headers.get("upload-offset")
    assert value is not None, "response is missing the Upload-Offset header"
    return int(value)


# --------------------------------------------------------------------------- #
# Criterion 1: HEAD after a partial PATCH returns the received Upload-Offset
# --------------------------------------------------------------------------- #


def test_head_after_partial_patch_returns_received_upload_offset(client):
    upload_url = create_upload(client, length=1024)
    chunk = b"the first part of a paper"

    partial = patch_bytes(client, upload_url, offset=0, data=chunk)
    assert partial.status_code in PATCH_OK, partial.text

    head = client.head(upload_url, headers=TUS_HEADERS)

    assert head.status_code == 200, head.text
    assert received_offset(head) == len(chunk)


def test_head_reports_the_offset_after_each_of_two_partial_patches(client):
    """An interrupted upload resumes: the second chunk continues at the offset
    HEAD reported after the first."""
    upload_url = create_upload(client, length=1024)
    first_chunk = b"first chunk. "
    second_chunk = b"second chunk."

    first = patch_bytes(client, upload_url, offset=0, data=first_chunk)
    assert first.status_code in PATCH_OK, first.text

    after_first = client.head(upload_url, headers=TUS_HEADERS)
    assert after_first.status_code == 200, after_first.text
    assert received_offset(after_first) == len(first_chunk)

    resumed = patch_bytes(
        client, upload_url, offset=received_offset(after_first), data=second_chunk
    )
    assert resumed.status_code in PATCH_OK, resumed.text

    head = client.head(upload_url, headers=TUS_HEADERS)
    assert head.status_code == 200, head.text
    assert received_offset(head) == len(first_chunk) + len(second_chunk)


# --------------------------------------------------------------------------- #
# Criterion 2: PATCH with a wrong Upload-Offset returns 409
# --------------------------------------------------------------------------- #


def test_patch_with_wrong_upload_offset_returns_409(client):
    upload_url = create_upload(client, length=1024)
    first_chunk = b"already received"

    accepted = patch_bytes(client, upload_url, offset=0, data=first_chunk)
    assert accepted.status_code in PATCH_OK, accepted.text

    # The server's offset is now len(first_chunk); a resumed client that
    # starts over at zero is out of step and must be told so.
    stale = patch_bytes(client, upload_url, offset=0, data=b"duplicate bytes")

    assert stale.status_code == 409, stale.text


def test_patch_beyond_the_received_offset_returns_409(client):
    upload_url = create_upload(client, length=1024)

    # No bytes have been received yet, so offset 10 (like any non-zero
    # value) does not match the server's current offset.
    ahead = patch_bytes(client, upload_url, offset=10, data=b"gap")

    assert ahead.status_code == 409, ahead.text
