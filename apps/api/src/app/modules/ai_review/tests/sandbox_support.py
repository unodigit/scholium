"""Test doubles for the sandbox tests (feature 119): a scripted docker and archive builders.

No test starts a container.  :class:`FakeDocker` answers the docker
sub-commands the sandbox uses and records each call, so a test can assert what
was asked of docker (the flags of ``create``, the order of the calls, that the
container was removed) and script what docker answers (daemon down, image
absent, exit codes, a hang).
"""

from __future__ import annotations

import io
import stat
import tarfile
import uuid
import zipfile
from pathlib import Path
from typing import Optional, Sequence, Union

from app.modules import content
from app.modules.ai_review.sandbox import CommandResult

CONTAINER_ID = "0123456789abcdef" * 4
IMAGE_ID = "sha256:" + "ab" * 32
#: A path that must never appear in a run log: docker's own error text names it.
HOST_SECRET = "/run/user/1000/docker-host-secret.sock"

Files = dict[str, Union[str, bytes]]


class FakeDocker:
    """A runner that plays a docker daemon; ``calls`` holds every argv it was given."""

    def __init__(
        self,
        *,
        server: bool = True,
        image: bool = True,
        create: bool = True,
        start: bool = True,
        exit_code: int = 0,
        hang: bool = False,
        oom: bool = False,
        output: bytes = b"",
        logs: bool = True,
        container_id: str = CONTAINER_ID,
    ) -> None:
        self.server = server
        self.image = image
        self.create = create
        self.start = start
        self.exit_code = exit_code
        self.hang = hang
        self.oom = oom
        self.output = output
        self.logs = logs
        self.container_id = container_id
        self.calls: list[list[str]] = []
        self.timeouts: list[float] = []
        self.merged: list[bool] = []

    def __call__(
        self, argv: Sequence[str], timeout: float, merge_stderr: bool = False
    ) -> CommandResult:
        self.calls.append(list(argv))
        self.timeouts.append(timeout)
        self.merged.append(merge_stderr)
        name = self.name(argv)
        failure = CommandResult(returncode=1, stderr=f"cannot reach {HOST_SECRET}".encode())
        if name == "version":
            return CommandResult(0, b"29.0.0\n") if self.server else failure
        if name == "image inspect":
            return CommandResult(0, f"{IMAGE_ID}\n".encode()) if self.image else failure
        if name == "create":
            # Docker prints warnings on stderr and the id alone on stdout.
            return CommandResult(0, f"{self.container_id}\n".encode()) if self.create else failure
        if name == "start":
            return CommandResult(0, f"{self.container_id}\n".encode()) if self.start else failure
        if name == "wait":
            if self.hang:
                return CommandResult(returncode=-1, timed_out=True)
            return CommandResult(0, f"{self.exit_code}\n".encode())
        if name == "inspect":
            return CommandResult(0, b"true\n" if self.oom else b"false\n")
        if name == "logs":
            return CommandResult(0, self.output) if self.logs else failure
        return CommandResult(0)  # kill, rm

    @staticmethod
    def name(argv: Sequence[str]) -> str:
        return "image inspect" if argv[1] == "image" else argv[1]

    @property
    def names(self) -> list[str]:
        return [self.name(argv) for argv in self.calls]

    def calls_to(self, name: str) -> list[list[str]]:
        return [argv for argv in self.calls if self.name(argv) == name]

    def timeout_of(self, name: str) -> float:
        (index,) = [i for i, argv in enumerate(self.calls) if self.name(argv) == name]
        return self.timeouts[index]


def flag(argv: Sequence[str], name: str) -> list[str]:
    """The values that follow each occurrence of the option ``name`` in ``argv``."""
    return [argv[i + 1] for i, word in enumerate(argv[:-1]) if word == name]


def with_nonce(files: Files) -> Files:
    """``files`` plus one that makes the archive's cid unique to this test.

    xdist workers share the ``blobs`` table, and storing the same bytes again
    never changes a ``scan_status``.
    """
    return {**files, ".nonce": uuid.uuid4().hex}


def _raw(data: Union[str, bytes]) -> bytes:
    return data.encode() if isinstance(data, str) else data


def zip_bytes(
    files: Optional[Files] = None, entries: Sequence[tuple[zipfile.ZipInfo, bytes]] = ()
) -> bytes:
    """A zip of ``files`` (name -> content) followed by hand-made ``entries``."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in (files or {}).items():
            zf.writestr(name, _raw(data))
        for info, data in entries:
            zf.writestr(info, data)
    return buffer.getvalue()


def zip_info(name: str, mode: int, *, directory: bool = False) -> zipfile.ZipInfo:
    """A zip member with a Unix ``mode`` (e.g. ``stat.S_IFLNK | 0o777`` for a symlink)."""
    info = zipfile.ZipInfo(name + ("/" if directory else ""))
    info.create_system = 3
    info.external_attr = mode << 16
    return info


def tar_bytes(
    files: Optional[Files] = None,
    members: Sequence[tuple[tarfile.TarInfo, bytes]] = (),
    *,
    mode: str = "w:gz",
) -> bytes:
    """A tar of ``files`` (name -> content) followed by hand-made ``members``."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode=mode) as tf:
        for name, data in (files or {}).items():
            raw = _raw(data)
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(raw))
        for info, data in members:
            info.size = len(data) if info.isreg() else 0
            tf.addfile(info, io.BytesIO(data) if info.isreg() else None)
    return buffer.getvalue()


def tar_member(name: str, kind: bytes, *, link: str = "", mode: int = 0o644) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = link
    info.mode = mode
    return info


def store_bundle(data: bytes, *, scan: str = content.SCAN_PASSED) -> str:
    """Put ``data`` in the content store with the sanitizer's verdict ``scan``; its cid."""
    blob = content.store_bytes(data, media_type="application/zip")
    return content.set_scan_status(blob.cid, scan).cid


def runnable_bundle(files: Optional[Files] = None, *, scan: str = content.SCAN_PASSED) -> str:
    """A cleared zip bundle with a ``reproduce.sh``; its cid."""
    body = {"reproduce.sh": "echo hello\n", **(files or {})}
    return store_bundle(zip_bytes(with_nonce(body)), scan=scan)


def make_executable(path: Path) -> Path:
    """A stand-in ``docker`` executable: only ``shutil.which`` ever runs it."""
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path
