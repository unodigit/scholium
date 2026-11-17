"""Object storage behind one interface (plugin: storage).

Everything that keeps bytes keeps them through an :class:`ObjectStore`, so
where they live is a deployment choice, not a code path.  ``STORAGE_BACKEND``
selects the driver:

``fs`` (the default)
    :class:`FilesystemObjectStore` rooted at ``CONTENT_DIR``: the layout the
    content store has always used, written atomically and fsynced.
``s3``
    :class:`~app.storage.s3.S3ObjectStore` on ``S3_BUCKET`` at
    ``S3_ENDPOINT_URL`` (see the ``S3_*`` settings), through boto3.

::

    from app.storage import get_object_store

    store = get_object_store()
    store.put_stream("bafkrei...", stream)      # -> StoredObject(key, size, sha256)
    with store.open("bafkrei...", offset=10, length=5) as body:
        body.read()
    store.size(key); store.exists(key); store.delete(key)
    list(store.list("uploads/"))

:mod:`app.storage.base` documents the shared semantics, and
``app/storage/tests`` holds the one contract suite both drivers pass.

boto3 is imported only when the ``s3`` backend is selected, so the default
install never loads it.
"""

from __future__ import annotations

import functools

from app.settings import settings

from .base import (
    InvalidKeyError,
    InvalidRangeError,
    KeyConflictError,
    ObjectNotFoundError,
    ObjectStore,
    ObjectStoreError,
    StorageConfigError,
    StoredObject,
    SupportsRead,
    validate_key,
    validate_prefix,
)
from .filesystem import TMP_DIRNAME, FilesystemObjectStore

__all__ = [
    "FilesystemObjectStore",
    "InvalidKeyError",
    "InvalidRangeError",
    "KeyConflictError",
    "ObjectNotFoundError",
    "ObjectStore",
    "ObjectStoreError",
    "StorageConfigError",
    "StoredObject",
    "SupportsRead",
    "TMP_DIRNAME",
    "get_object_store",
    "validate_key",
    "validate_prefix",
]


def get_object_store() -> ObjectStore:
    """The object store ``settings.STORAGE_BACKEND`` selects.

    Settings are read on every call, so a changed ``CONTENT_DIR`` (tests do
    this constantly) or backend takes effect at once.  The filesystem store is
    a thin object and is built fresh each time; the S3 store owns a client, so
    one is built per distinct configuration and shared.

    Raises:
        StorageConfigError: the backend is unknown, or lacks what it needs
            (``CONTENT_DIR``; ``S3_BUCKET``).
    """
    backend = (settings.STORAGE_BACKEND or "fs").strip().lower()
    if backend == "fs":
        root = settings.CONTENT_DIR
        if not root or not root.strip():
            raise StorageConfigError("CONTENT_DIR is not configured")
        return FilesystemObjectStore(root)
    if backend == "s3":
        bucket = (settings.S3_BUCKET or "").strip()
        if not bucket:
            raise StorageConfigError("S3_BUCKET is not configured")
        return _s3_store(
            bucket,
            (settings.S3_ENDPOINT_URL or "").strip(),
            (settings.S3_REGION or "").strip(),
            (settings.S3_ACCESS_KEY_ID or "").strip(),
            (settings.S3_SECRET_ACCESS_KEY or "").strip(),
            bool(settings.S3_FORCE_PATH_STYLE),
        )
    raise StorageConfigError(f"Unknown STORAGE_BACKEND {backend!r}; expected one of fs, s3")


@functools.lru_cache(maxsize=8)
def _s3_store(
    bucket: str,
    endpoint_url: str,
    region: str,
    access_key_id: str,
    secret_access_key: str,
    force_path_style: bool,
) -> ObjectStore:
    from .s3 import S3ObjectStore  # boto3 is only loaded once s3 is in use

    return S3ObjectStore(
        bucket,
        endpoint_url=endpoint_url,
        region=region,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        force_path_style=force_path_style,
    )
