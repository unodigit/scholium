"""The caller identity an export route reads to widen what it may serve (export).

Exporting is public, so a token is never required.  It is read only to widen
access to the bytes of a paper that is not listed yet: for those,
:func:`app.modules.content.visibility.may_read` admits the version's authors
and moderators (tier 4), and the exporters hand this principal to it.

A token that is present but unusable is ignored rather than turning a public
download into a ``401`` -- the same courtesy ``content.router`` pays its
readers.
"""

from __future__ import annotations

from typing import Optional

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.security import InvalidAccessToken, Principal, decode_access_token

__all__ = [
    "optional_principal",
]

_bearer = HTTPBearer(auto_error=False)


def optional_principal(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[Principal]:
    """The caller when the request carries a usable token, otherwise ``None``."""
    if credentials is None:
        return None
    try:
        return decode_access_token(credentials.credentials)
    except InvalidAccessToken:
        return None
