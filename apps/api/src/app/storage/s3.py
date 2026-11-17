"""The S3 ObjectStore driver: objects in one bucket behind the S3 API.

``STORAGE_BACKEND=s3`` selects it; ``S3_BUCKET`` names the bucket,
``S3_ENDPOINT_URL`` the service (leave it unset for the client's default,
set it for MinIO, R2 and the like), and ``S3_REGION``, ``S3_ACCESS_KEY_ID``,
``S3_SECRET_ACCESS_KEY`` and ``S3_FORCE_PATH_STYLE`` complete the client.
``boto3`` is used purely as an S3 API client: nothing here knows which
provider is on the other end.

A key is the S3 object key as it stands, so the bucket holds the same names
the filesystem driver would hold as paths.

Writes are as atomic as S3 makes them: an object appears whole or not at all.
A stream up to one part is a single ``PutObject``.  A longer one is a
multipart upload, read and sent one part at a time so memory stays near the
part size however large the stream is; if anything goes wrong the multipart
upload is aborted so no orphaned parts keep costing storage.  Reads stream the
response body; a byte range is a ranged ``GetObject``.

The driver holds one boto3 client, which is safe to share between threads.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from itertools import chain
from typing import Any, BinaryIO, Optional

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from .base import (
    ChunkSource,
    InvalidRangeError,
    ObjectNotFoundError,
    ObjectStore,
    ObjectStoreError,
    RawStream,
    StorageConfigError,
    StoredObject,
    SupportsRead,
    empty_stream,
    is_valid_key,
    validate_key,
    validate_prefix,
    validate_range,
)

__all__ = ["DEFAULT_PART_SIZE", "MIN_PART_SIZE", "S3ObjectStore"]

logger = logging.getLogger(__name__)

#: The smallest part S3 accepts for any part but the last of a multipart upload.
MIN_PART_SIZE = 5 * 1024 * 1024
#: How much of a stream is buffered, and so how big each multipart part is.
#: S3 allows 10,000 parts, so this reaches 80 GiB; uploads here stop at 5 GiB.
DEFAULT_PART_SIZE = 8 * 1024 * 1024

#: Error codes meaning "no such object" (a ``HEAD`` carries only the status).
_MISSING_CODES = frozenset({"404", "NoSuchKey", "NotFound"})


class S3ObjectStore(ObjectStore):
    """Objects in ``bucket``, through an S3-API endpoint.

    ``endpoint_url`` and ``region`` of ``None`` leave them to the client's own
    defaults, as do both credentials being ``None`` (the client then looks
    them up as it normally does).  Giving only one credential is refused.
    ``force_path_style`` addresses the bucket as ``endpoint/bucket/key``
    rather than ``bucket.endpoint/key``.  ``part_size`` is how many bytes of a
    large stream are buffered and sent at a time; S3 requires at least
    :data:`MIN_PART_SIZE`.
    """

    def __init__(
        self,
        bucket: str,
        *,
        endpoint_url: Optional[str] = None,
        region: Optional[str] = None,
        access_key_id: Optional[str] = None,
        secret_access_key: Optional[str] = None,
        force_path_style: bool = False,
        part_size: int = DEFAULT_PART_SIZE,
    ) -> None:
        if not (bucket or "").strip():
            raise StorageConfigError("S3_BUCKET is not configured")
        if bool(access_key_id) != bool(secret_access_key):
            raise StorageConfigError(
                "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together"
            )
        if part_size < MIN_PART_SIZE:
            raise StorageConfigError(f"part_size must be at least {MIN_PART_SIZE} bytes")
        self._bucket = bucket
        self._part_size = part_size
        config = Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if force_path_style else "auto"},
            retries={"max_attempts": 5, "mode": "standard"},
            connect_timeout=5,
            read_timeout=60,
            # Only checksum what an operation requires: the extra integrity
            # headers newer clients add by default are rejected by a number of
            # S3-compatible servers, and the content store verifies every blob
            # against its CID anyway.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        )
        # A session of our own: the module-level default session is not safe
        # to build clients from on several threads at once.
        self._client = boto3.session.Session().client(
            "s3",
            endpoint_url=endpoint_url or None,
            region_name=region or None,
            aws_access_key_id=access_key_id or None,
            aws_secret_access_key=secret_access_key or None,
            config=config,
        )

    @property
    def bucket(self) -> str:
        return self._bucket

    # -- writing ------------------------------------------------------------

    def put_stream(self, key: str, stream: SupportsRead) -> StoredObject:
        validate_key(key)
        source = ChunkSource(stream)
        parts = _parts(source, self._part_size)
        try:
            body, last = next(parts)
            if last:
                self._client.put_object(Bucket=self._bucket, Key=key, Body=body)
            else:
                self._put_multipart(key, chain([(body, False)], parts))
        except (ClientError, BotoCoreError) as exc:
            raise _wrap(exc, f"could not store {key!r}") from exc
        return source.stored(key)

    def _put_multipart(self, key: str, parts: Iterator[tuple[bytes, bool]]) -> None:
        upload_id = self._client.create_multipart_upload(Bucket=self._bucket, Key=key)["UploadId"]
        try:
            done = []
            for number, (body, _last) in enumerate(parts, start=1):
                etag = self._client.upload_part(
                    Bucket=self._bucket, Key=key, UploadId=upload_id, PartNumber=number, Body=body
                )["ETag"]
                done.append({"ETag": etag, "PartNumber": number})
            self._client.complete_multipart_upload(
                Bucket=self._bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": done}
            )
        except BaseException:
            self._abort(key, upload_id)
            raise

    def _abort(self, key: str, upload_id: str) -> None:
        """Best effort: the original failure is the one worth reporting."""
        try:
            self._client.abort_multipart_upload(Bucket=self._bucket, Key=key, UploadId=upload_id)
        except (ClientError, BotoCoreError):
            logger.warning("could not abort multipart upload %s of %r", upload_id, key, exc_info=True)

    def delete(self, key: str) -> None:
        validate_key(key)
        try:
            self._client.delete_object(Bucket=self._bucket, Key=key)
        except (ClientError, BotoCoreError) as exc:
            raise _wrap(exc, f"could not delete {key!r}") from exc

    # -- reading ------------------------------------------------------------

    def open(self, key: str, *, offset: int = 0, length: Optional[int] = None) -> BinaryIO:
        validate_key(key)
        validate_range(offset, length)
        if length == 0:
            # S3 has no empty range: answer from the size alone.
            return self._empty_range(key, offset)
        arguments: dict[str, Any] = {}
        if offset or length is not None:
            last = "" if length is None else str(offset + length - 1)
            arguments["Range"] = f"bytes={offset}-{last}"
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key, **arguments)
        except ClientError as exc:
            code = _code(exc)
            if code in _MISSING_CODES:
                raise ObjectNotFoundError(f"no object at {key!r}") from None
            if code == "InvalidRange":
                # Starting at or past the end.  Only at the end is that fine.
                return self._empty_range(key, offset)
            raise _wrap(exc, f"could not read {key!r}") from exc
        except BotoCoreError as exc:
            raise _wrap(exc, f"could not read {key!r}") from exc
        return RawStream(_Body(response["Body"]))  # type: ignore[return-value]

    def _empty_range(self, key: str, offset: int) -> BinaryIO:
        size = self.size(key)
        if offset > size:
            raise InvalidRangeError(f"offset {offset} is beyond the end of {key!r} ({size} bytes)")
        return empty_stream()

    def size(self, key: str) -> int:
        validate_key(key)
        try:
            return int(self._client.head_object(Bucket=self._bucket, Key=key)["ContentLength"])
        except ClientError as exc:
            if _code(exc) in _MISSING_CODES:
                raise ObjectNotFoundError(f"no object at {key!r}") from None
            raise _wrap(exc, f"could not stat {key!r}") from exc
        except BotoCoreError as exc:
            raise _wrap(exc, f"could not stat {key!r}") from exc

    def exists(self, key: str) -> bool:
        try:
            self.size(key)
        except ObjectNotFoundError:
            return False
        return True

    def list(self, prefix: str = "") -> Iterator[str]:
        validate_prefix(prefix)
        return self._list(prefix)

    def _list(self, prefix: str) -> Iterator[str]:
        paginator = self._client.get_paginator("list_objects_v2")
        try:
            for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
                for item in page.get("Contents", ()):
                    # Names this interface cannot address (folder markers,
                    # dot-names made by other tools) are not objects of ours.
                    if is_valid_key(item["Key"]):
                        yield item["Key"]
        except (ClientError, BotoCoreError) as exc:
            raise _wrap(exc, f"could not list {prefix!r}") from exc


def _parts(source: ChunkSource, part_size: int) -> Iterator[tuple[bytes, bool]]:
    """``(body, is_last)`` for each part of ``source``, ``part_size`` bytes apiece but the last.

    A part is only emitted as not-last once at least one byte beyond it has
    been read, so a stream of exactly ``part_size`` bytes is one (last) part,
    and a stream is never left ending in an empty part.  An empty stream is
    one empty last part.
    """
    buffer = bytearray()
    for chunk in source:
        buffer += chunk
        while len(buffer) > part_size:
            yield bytes(buffer[:part_size]), False
            del buffer[:part_size]
    yield bytes(buffer), True


class _Body:
    """An S3 response body as a :class:`~app.storage.base.RawStream` source.

    Failures while the body streams are reported as the interface's own error.
    """

    def __init__(self, body) -> None:
        self._body = body

    def read(self, size: int, /) -> bytes:
        try:
            return self._body.read(size)
        except BotoCoreError as exc:
            raise _wrap(exc, "could not read the object body") from exc

    def close(self) -> None:
        self._body.close()


def _code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


def _wrap(exc: Exception, what: str) -> ObjectStoreError:
    """The interface's error for a client failure, naming what failed and why.

    The client's messages describe the request and the service's answer; they
    never include the credentials.
    """
    if isinstance(exc, ClientError):
        message = str(exc.response.get("Error", {}).get("Message", ""))
        detail = f"{_code(exc)}: {message}" if message else _code(exc)
        return ObjectStoreError(f"{what}: {detail or 'error'}")
    return ObjectStoreError(f"{what}: {exc}")
