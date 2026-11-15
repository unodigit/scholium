"""Export and interoperability endpoints (plugin: export).

Feature 94: ``GET /v1/oai`` is this node's OAI-PMH 2.0 interface.  Every listed
paper is one record with Dublin Core (``oai_dc``) metadata, so a harvester can
mirror the public catalog without understanding Scholium's signed records; see
:mod:`app.modules.export.oai` for the protocol surface and
:mod:`app.modules.export.records` for what a record describes.

The module loader discovers packages under ``app.modules`` automatically and
mounts the ``router`` exported here under ``/v1``.  There is no other wiring.
"""

from __future__ import annotations

from .oai import router

__all__ = ["router"]
