"""HTTP route for the network transparency plugin.

The module loader mounts this router under ``/v1``, so it serves
``GET /v1/network``.  The endpoint is public: it is the transparency page a
reader can open without an account, and it writes nothing.
"""

from __future__ import annotations

from fastapi import APIRouter

from .summary import NetworkStatus, network_summary

__all__ = ["router"]

#: Router the module loader mounts under ``/v1`` (serves ``/v1/network``).
router = APIRouter(tags=["network"])


@router.get(
    "/network",
    response_model=NetworkStatus,
    summary="Return this node's public network status",
)
def get_network() -> NetworkStatus:
    """Return the node DID, log head, anchor status, replicas and moderation counts.

    ``log_head`` is the log's current last entry (``seq`` 0 over the genesis
    digest for an empty log), ``last_anchor.status`` is always ``"pending"``
    because this node does not anchor on-chain yet, ``replicas`` is the local
    ``1 of 1 local`` summary, and ``moderation.by_clause`` counts accepted
    decisions per cited policy clause.  No credentials are required and
    nothing is written.
    """
    return network_summary()
