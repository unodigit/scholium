"""Unpacking a code bundle so the sandbox can mount it (feature 119).

A code bundle is a zip or tar archive (``.tar``, ``.tar.gz``, ``.tar.bz2``,
``.tar.xz``) in the content store.  It is untrusted: the sanitizer scans it
for traversal, links and absolute paths, and this module still refuses to
trust that verdict, because it is the code that writes the files::

    root = extract_stored_bundle(cid, workdir)                # a directory
    find_entrypoint(root)                                     # "reproduce.sh"

The stored bytes are reached through ``content.local_copy``, so the bundle is
read the same way whatever ``STORAGE_BACKEND`` is -- a file under
``CONTENT_DIR`` or an object in a bucket behind the S3 API -- and never
through a filesystem path that only one backend has.  :func:`extract_bundle`
still takes an archive file, for a caller that already has the bytes.

Only regular files and directories are written.  A symlink, hard link, device,
fifo, absolute path or ``..`` segment rejects the whole bundle; nothing is
skipped silently, because a half-unpacked bundle would give a misleading run.
The sizes are limited by what is actually written, not by what the archive
header claims, so a decompression bomb stops at ``max_bytes``.

Modes are normalized (directories ``0755``, files ``0644``, or ``0755`` when
the archive marked them executable) and ownership is whatever the caller's
process has, so the container's unprivileged user can read the mount whatever
the host umask is.

A zip made on macOS carries a ``__MACOSX/`` resource-fork directory; it is
dropped.  When everything is inside one top-level directory (the usual
``project-1.0/`` of a source tarball) that directory is the bundle root.

The entry point is the convention ``reproduce.sh``, then ``run.sh``, at the
bundle root; it is run with ``sh``, so it needs no executable bit.
"""

from __future__ import annotations

import os
import re
import stat
import tarfile
import zipfile
from pathlib import Path
from typing import IO, Optional, Union

from .errors import BundleError

__all__ = [
    "ENTRYPOINTS",
    "MAX_FILES",
    "MAX_NAME_LENGTH",
    "REASON_BUNDLE_REJECTED",
    "REASON_BUNDLE_UNAVAILABLE",
    "extract_bundle",
    "extract_stored_bundle",
    "find_entrypoint",
]

#: ``not_run`` reason: the bundle is missing, unreadable or not an archive.
REASON_BUNDLE_UNAVAILABLE = "bundle_unavailable"
#: ``not_run`` reason: the bundle is readable but unsafe or too large to run.
REASON_BUNDLE_REJECTED = "bundle_rejected"

#: Entry points tried in order, relative to the bundle root.
ENTRYPOINTS: tuple[str, ...] = ("reproduce.sh", "run.sh")

#: Most entries (files and directories) an archive may hold.
MAX_FILES = 5_000

#: Longest archive member name accepted, in characters.
MAX_NAME_LENGTH = 1_024

_MAX_COMPONENT_LENGTH = 255
_CHUNK = 64 * 1024
_RESOURCE_FORK_DIR = "__MACOSX"
_DRIVE_LETTER = re.compile(r"^[A-Za-z]:")


def _reject(detail: str) -> BundleError:
    return BundleError(REASON_BUNDLE_REJECTED, detail)


def _unavailable(detail: str) -> BundleError:
    return BundleError(REASON_BUNDLE_UNAVAILABLE, detail)


def _member_parts(name: str) -> Optional[tuple[str, ...]]:
    """The path components of an archive member name, or ``None`` to skip it.

    Raises:
        BundleError: for an absolute path, a ``..`` segment, a NUL, or a name
            that is unreasonably long.
    """
    if "\0" in name:
        raise _reject("an archive entry name contains a NUL byte")
    if len(name) > MAX_NAME_LENGTH:
        raise _reject("an archive entry name is too long")
    # Windows tools write backslashes; read them as separators so that
    # ``..\\..\\x`` is caught as traversal rather than kept as a file name.
    unified = name.replace("\\", "/")
    if unified.startswith("/") or _DRIVE_LETTER.match(unified):
        raise _reject("an archive entry has an absolute path")
    parts = tuple(part for part in unified.split("/") if part not in ("", "."))
    if ".." in parts:
        raise _reject("an archive entry has a '..' path segment")
    if any(len(part) > _MAX_COMPONENT_LENGTH for part in parts):
        raise _reject("an archive entry name is too long")
    if not parts or parts[0] == _RESOURCE_FORK_DIR:
        return None
    return parts


class _Writer:
    """Writes entries under ``dest`` and keeps the running totals."""

    def __init__(self, dest: Path, max_files: int, max_bytes: int) -> None:
        self.dest = dest
        self.root = dest.resolve()
        self.max_files = max_files
        self.max_bytes = max_bytes
        self.entries = 0
        self.files = 0
        self.written = 0

    def _target(self, parts: tuple[str, ...]) -> Path:
        target = self.dest.joinpath(*parts)
        # Belt and braces: ``parts`` has no '..', and no link is ever written.
        if not target.resolve().is_relative_to(self.root):
            raise _reject("an archive entry would be written outside the bundle")
        return target

    def count_entry(self) -> None:
        self.entries += 1
        if self.entries > self.max_files:
            raise _reject(f"the archive has more than {self.max_files} entries")

    def directory(self, parts: tuple[str, ...]) -> None:
        try:
            self._target(parts).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise _reject("archive entries conflict with each other") from exc

    def file(
        self, parts: tuple[str, ...], source: IO[bytes], executable: bool
    ) -> None:
        target = self._target(parts)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as out:
                while chunk := source.read(_CHUNK):
                    self.written += len(chunk)
                    if self.written > self.max_bytes:
                        raise _reject(
                            "the bundle unpacks to more than "
                            f"{self.max_bytes // (1024 * 1024)} MiB"
                        )
                    out.write(chunk)
            os.chmod(target, 0o755 if executable else 0o644)
        except OSError as exc:
            raise _reject("archive entries conflict with each other") from exc
        self.files += 1


def _extract_zip(archive: Path, writer: _Writer) -> None:
    with zipfile.ZipFile(archive) as zf:
        infos = zf.infolist()
        if len(infos) > writer.max_files:
            raise _reject(f"the archive has more than {writer.max_files} entries")
        if sum(info.file_size for info in infos) > writer.max_bytes:
            raise _reject(
                "the bundle unpacks to more than "
                f"{writer.max_bytes // (1024 * 1024)} MiB"
            )
        for info in infos:
            writer.count_entry()
            # The Unix mode is in the high 16 bits; 0 when the zip has none.
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise _reject("the archive holds a link or special file")
            parts = _member_parts(info.filename)
            if parts is None:
                continue
            if info.is_dir() or kind == stat.S_IFDIR:
                writer.directory(parts)
                continue
            with zf.open(info) as source:
                writer.file(parts, source, executable=bool(mode & 0o111))


def _extract_tar(archive: Path, writer: _Writer) -> None:
    with tarfile.open(archive, "r:*") as tf:
        for member in tf:
            writer.count_entry()
            if not (member.isdir() or member.isreg()):
                raise _reject("the archive holds a link or special file")
            parts = _member_parts(member.name)
            if parts is None:
                continue
            if member.isdir():
                writer.directory(parts)
                continue
            source = tf.extractfile(member)
            if source is None:  # pragma: no cover - isreg() members have data
                raise _unavailable("an archive entry could not be read")
            with source:
                writer.file(parts, source, executable=bool(member.mode & 0o111))


def extract_bundle(
    archive: Union[str, Path],
    dest: Union[str, Path],
    *,
    max_files: int = MAX_FILES,
    max_bytes: int = 256 * 1024 * 1024,
) -> Path:
    """Unpack the zip or tar ``archive`` into the empty directory ``dest``.

    Args:
        archive: the bundle's file.
        dest: an existing, empty directory owned by the caller.
        max_files: the most entries the archive may hold.
        max_bytes: the most bytes of file content it may unpack to.

    Returns:
        The bundle root: ``dest``, or the one directory inside it that holds
        everything.

    Raises:
        BundleError: ``bundle_unavailable`` if the file is missing, not a zip
            or tar archive, encrypted or damaged; ``bundle_rejected`` if it
            holds an unsafe entry, is empty, or exceeds the limits.
    """
    archive = Path(archive)
    dest = Path(dest)
    writer = _Writer(dest, max_files, max_bytes)
    try:
        if zipfile.is_zipfile(archive):
            _extract_zip(archive, writer)
        elif tarfile.is_tarfile(archive):
            _extract_tar(archive, writer)
        else:
            raise _unavailable("the bundle is not a zip or tar archive")
    except BundleError:
        raise
    except Exception as exc:
        # The archive is untrusted, so the parsers' failures are not a closed
        # set: BadZipFile, TarError, EOFError and OSError, but also zlib.error
        # and lzma.LZMAError (neither is an OSError) for a corrupt stream,
        # RuntimeError for an encrypted zip member, NotImplementedError for an
        # unsupported compression.  Whatever it is, the bundle cannot be read.
        raise _unavailable(f"the bundle could not be read ({type(exc).__name__})") from exc
    if writer.files == 0:
        raise _reject("the bundle holds no files")

    for directory, _names, _files in os.walk(dest):
        os.chmod(directory, 0o755)
    children = list(dest.iterdir())
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return dest


def extract_stored_bundle(
    cid: str,
    dest: Union[str, Path],
    *,
    max_files: int = MAX_FILES,
    max_bytes: int = 256 * 1024 * 1024,
) -> Path:
    """Unpack the bundle stored at file id ``cid`` into the empty directory ``dest``.

    The bytes come from the content store through
    :func:`app.modules.content.local_copy`, which hands out a real file on
    every storage backend; the copy is removed once the archive has been
    unpacked.  Otherwise this is :func:`extract_bundle`, with the same limits
    and the same guarantees.

    Raises:
        ValueError: ``cid`` is not a canonical file id.
        BundleError: ``bundle_unavailable`` if the bytes are not stored;
            otherwise exactly what :func:`extract_bundle` raises for an
            unsafe or damaged archive.
    """
    from app.modules import content

    try:
        with content.local_copy(cid) as archive:
            return extract_bundle(archive, dest, max_files=max_files, max_bytes=max_bytes)
    except FileNotFoundError:
        # The bytes went after the caller looked (a tombstone, say), or were
        # never there: either way the bundle cannot be run.
        raise _unavailable("the code bundle is not in the content store") from None


def find_entrypoint(root: Union[str, Path]) -> Optional[str]:
    """The first of :data:`ENTRYPOINTS` that is a regular file in ``root``."""
    root = Path(root)
    for name in ENTRYPOINTS:
        if (root / name).is_file():
            return name
    return None
