"""Versions of the tools a version's scan used (plugin: sanitizer).

A ``rendition`` record (feature 64) names the tools that judged its files, so
anyone reading it can tell which scanner releases cleared the bytes::

    from app.modules.sanitizer import tools

    tools.tool_versions({"pdf", "bundle"})
    # [{"name": "scholium-sanitizer", "version": "0.1.0"},
    #  {"name": "pypdf", "version": "6.0.0"},
    #  {"name": "clamav", "version": "1.4.2", "database": "27500"}]

Only tools that actually ran are listed: ``pypdf`` when a PDF was scanned and
ClamAV when an archive was.  (A passing archive means clamd answered -- the
bundle scan fails with ``av_unavailable`` otherwise -- so ClamAV is asked for
its version, never assumed.)  A version that cannot be determined is left out
of its entry rather than guessed; the entry still names the tool.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable
from importlib import metadata
from typing import Optional

from .bundle import _clamd_connect

__all__ = [
    "CLAMAV_TOOL",
    "KIND_BUNDLE",
    "KIND_OTHER",
    "KIND_PDF",
    "PYPDF_TOOL",
    "SANITIZER_TOOL",
    "tool_versions",
]

logger = logging.getLogger(__name__)

#: The checks implemented in this package (hidden text, archive structure,
#: report writing).  They ship in the API package, so that package's version
#: is the sanitizer's.
SANITIZER_TOOL = "scholium-sanitizer"
PYPDF_TOOL = "pypdf"
CLAMAV_TOOL = "clamav"

#: The kinds of file the scan dispatches on (see ``scan_job._kind_of``).
KIND_PDF = "pdf"
KIND_BUNDLE = "bundle"
KIND_OTHER = "other"

_SANITIZER_DISTRIBUTION = "scholium-api"
#: How long to wait on clamd when asking for its version.
_CLAMD_TIMEOUT = 5.0
_MAX_REPLY = 4096


def _distribution_version(name: str) -> Optional[str]:
    """The installed version of distribution ``name``, or ``None``."""
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _tool(name: str, version: Optional[str], **extra: str) -> dict[str, str]:
    """A ``tools`` entry; ``version`` is left out when it is not known."""
    entry = {"name": name}
    if version:
        entry["version"] = version
    entry.update(extra)
    return entry


def _parse_clamd_version(reply: str) -> tuple[Optional[str], Optional[str]]:
    """``(version, database)`` from clamd's ``ClamAV 1.4.2/27500/<date>`` reply."""
    program, _, rest = reply.strip().partition("/")
    name, _, version = program.partition(" ")
    if name.lower() != "clamav" or not version.strip():
        return None, None
    database = rest.partition("/")[0].strip()
    return version.strip(), database or None


def _clamd_version(socket_path: str) -> tuple[Optional[str], Optional[str]]:
    """Ask clamd at ``socket_path`` for ``(version, database)``; never raises."""
    try:
        sock = _clamd_connect(socket_path, timeout=_CLAMD_TIMEOUT)
        try:
            sock.sendall(b"VERSION\n")
            reply = b""
            while b"\n" not in reply and len(reply) < _MAX_REPLY:
                chunk = sock.recv(_MAX_REPLY)
                if not chunk:
                    break
                reply += chunk
        finally:
            sock.close()
    except (OSError, ValueError) as exc:
        logger.warning("could not read the ClamAV version: %s", exc)
        return None, None
    return _parse_clamd_version(reply.decode("utf-8", errors="replace").strip("\x00\n "))


def tool_versions(kinds: Iterable[str]) -> list[dict[str, str]]:
    """The ``tools`` entries for a scan that handled files of ``kinds``.

    The sanitizer itself is always listed.  Each entry is
    ``{"name": ..., "version": ...}`` (ClamAV adds its signature ``database``
    release), the shape the ``rendition`` schema accepts.
    """
    seen = set(kinds)
    tools = [_tool(SANITIZER_TOOL, _distribution_version(_SANITIZER_DISTRIBUTION))]
    if KIND_PDF in seen:
        tools.append(_tool(PYPDF_TOOL, _distribution_version("pypdf")))
    if KIND_BUNDLE in seen:
        version, database = (None, None)
        socket_path = os.getenv("CLAMD_SOCKET", "")
        if socket_path:
            version, database = _clamd_version(socket_path)
        extra = {"database": database} if database else {}
        tools.append(_tool(CLAMAV_TOOL, version, **extra))
    return tools
