"""The sandbox service: ``python -m app.sandbox_service``.

Serves the reproducibility sandbox over HTTP for a node running with
``SANDBOX_BACKEND=remote``::

    POST /runs        {"bundle_cid": ..., "limits": {...}}   -> 202 {"run_id": ...}
    GET  /runs/{id}                                          -> status and log_lines

It is a separate entry point, not a plugin: the module loader scans
``app.modules`` and never starts this.  See :mod:`app.sandbox_service.app` for
the contract, the configuration and how a run is made, and
:mod:`app.modules.ai_review.sandbox` for the client side.
"""

from .app import (
    BundleStore,
    FilesystemStore,
    ServiceConfigError,
    ServiceProblem,
    create_app,
    default_store,
    run_archive,
)

__all__ = [
    "BundleStore",
    "FilesystemStore",
    "ServiceConfigError",
    "ServiceProblem",
    "create_app",
    "default_store",
    "run_archive",
]
