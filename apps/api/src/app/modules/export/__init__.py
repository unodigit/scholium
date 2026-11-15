"""Export and interoperability endpoints (plugin: export).

Feature 91: ``GET /v1/export/paper/{id}.car`` returns a CARv1 archive of every
record, file and log entry for one paper, so a reader can keep and verify a
copy offline.  See :mod:`app.modules.export.paper_car` for the route and
:mod:`app.modules.export.paper` for what an archive holds.

Feature 94: ``GET /v1/oai`` is this node's OAI-PMH 2.0 interface.  Every listed
paper is one record with Dublin Core (``oai_dc``) metadata, so a harvester can
mirror the public catalog without understanding Scholium's signed records; see
:mod:`app.modules.export.oai` for the protocol surface and
:mod:`app.modules.export.records` for what a record describes.

The module loader discovers packages under ``app.modules`` automatically and
mounts the ``router`` exported here under ``/v1``.  There is no other wiring.
"""

from __future__ import annotations

from fastapi import APIRouter

from .oai import router as _oai_router
from .paper_car import router as _paper_car_router
from .user_car import router as _user_car_router

__all__ = ["router"]

#: Mounted under ``/v1`` by the module loader.  One sub-router per endpoint.
router = APIRouter()
router.include_router(_oai_router)
router.include_router(_paper_car_router)
router.include_router(_user_car_router)

