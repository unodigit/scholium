"""Make ``scholium_record_core`` importable for a plain ``uv run``.

``seed-demo`` signs records, so it needs the record core.  That is a workspace
package (``apps/api/packages/record-core``), and ``uv run python -m
app.modules.admin ...`` -- without ``--all-packages`` -- does not install it:
``scholium-api`` does not depend on it, and ``uv`` only syncs the other
workspace members on request.  ``set-tier`` sidesteps this by not importing the
record core at all (see :mod:`app.modules.admin.service`); signing records
cannot.

When the package is not installed, this falls back to the very source tree an
editable ``--all-packages`` install would point at.  It is appended to
``sys.path`` -- never put first -- so an installed copy always wins.  The
package's own dependencies (``dag-cbor``, ``multiformats``, ``pynacl``,
``pydantic``) are ``scholium-api`` dependencies too, so they are present.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

__all__ = ["RecordCoreUnavailable", "ensure_record_core"]

_PACKAGE = "scholium_record_core"

# .../apps/api/src/app/modules/admin/bootstrap.py -> .../apps/api
_API_ROOT = Path(__file__).resolve().parents[4]
_WORKSPACE_SOURCE = _API_ROOT / "packages" / "record-core" / "src"


class RecordCoreUnavailable(RuntimeError):
    """``scholium_record_core`` is neither installed nor in the workspace."""


def ensure_record_core() -> None:
    """Import ``scholium_record_core``, from the workspace checkout if need be.

    Raises:
        RecordCoreUnavailable: it is not installed and the workspace package is
            not next to this module (an installed ``app`` without the repo).
    """
    try:
        module = importlib.import_module(_PACKAGE)
    except ModuleNotFoundError as exc:
        if exc.name != _PACKAGE:
            raise  # the record core is there but one of *its* imports is missing
    else:
        if getattr(module, "__file__", None) is not None:
            return
        # A bare directory of that name (an editable install leaves a
        # ``scholium_record_core/record_schemas`` one in site-packages) imports as an
        # empty namespace package.  That is not the record core: forget it, so the
        # real one can be imported below.
        sys.modules.pop(_PACKAGE, None)

    if not (_WORKSPACE_SOURCE / _PACKAGE).is_dir():
        raise RecordCoreUnavailable(
            f"{_PACKAGE} is not installed and {_WORKSPACE_SOURCE} does not exist; "
            "run from the repository with `uv run --all-packages python -m app.modules.admin seed-demo`"
        )
    source = str(_WORKSPACE_SOURCE)
    if source not in sys.path:
        sys.path.append(source)
    importlib.invalidate_caches()
    importlib.import_module(_PACKAGE)
