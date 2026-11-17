"""ORCID iD syntax, checksums and the dev mock's generated identifiers.

A bare ORCID iD is four groups of four digits, the last character being the
ISO 7064 MOD 11-2 check character (``0-9`` or ``X``)::

    0000-0002-1825-0097

:func:`is_valid_orcid_id` enforces both the shape and the checksum, so the
mock consent page can refuse to approve a mistyped iD.
:func:`generate_mock_orcid_id` mints a fresh, checksum-valid iD for the
``ORCID_MOCK`` consent page: each authorization gets a different one, so
several newcomers on one node can each link an account.

This module has no FastAPI or database imports, so the mock page, the code
exchange and tests can all share it without import cycles.
"""

from __future__ import annotations

import re
import secrets
import threading

__all__ = [
    "format_orcid_id",
    "generate_mock_orcid_id",
    "is_valid_orcid_id",
    "orcid_check_character",
]

#: A bare, upper-case iD: 15 digits, three hyphens, then the check character.
_BARE_ORCID = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")

#: Generated ids already handed out in this process.  The mock is a development
#: aid on a single node; keeping them here guarantees two authorizations never
#: see the same offered iD, which is what makes a second newcomer link work.
_issued: set[str] = set()
_issued_lock = threading.Lock()


def orcid_check_character(digits: str) -> str:
    """Return the ISO 7064 MOD 11-2 check character for 15 digit characters.

    ``digits`` must be exactly the first fifteen digits of the iD (no hyphens).
    The result is ``"0"``-``"9"`` or ``"X"``.
    """
    if not isinstance(digits, str) or len(digits) != 15 or not digits.isdigit():
        raise ValueError("an ORCID checksum is computed from fifteen digits")
    total = 0
    for digit in digits:
        total = (total + int(digit)) * 2
    value = (12 - total % 11) % 11
    return "X" if value == 10 else str(value)


def format_orcid_id(digits: str) -> str:
    """Format sixteen checked digits as ``0000-0000-0000-000X``."""
    if not isinstance(digits, str) or len(digits) != 16:
        raise ValueError("an ORCID iD is sixteen characters including its check digit")
    return f"{digits[0:4]}-{digits[4:8]}-{digits[8:12]}-{digits[12:15]}{digits[15].upper()}"


def is_valid_orcid_id(value: str) -> bool:
    """True when ``value`` is a bare ORCID iD with a valid check character.

    Surrounding whitespace is ignored and a lower-case ``x`` is accepted as the
    check character; anything shaped differently is false.
    """
    if not isinstance(value, str):
        return False
    text = value.strip().upper()
    if _BARE_ORCID.fullmatch(text) is None:
        return False
    digits = text.replace("-", "")
    return digits[15] == orcid_check_character(digits[:15])


def generate_mock_orcid_id() -> str:
    """Return a fresh, checksum-valid ORCID iD not offered before in this process.

    Only the mock consent page uses this.  The random part is drawn with
    :mod:`secrets`; the checksum makes the offered value a *valid* iD, and the
    process-local set makes two authorizations on one node distinct even in the
    (astronomically unlikely) event of a random collision.
    """
    with _issued_lock:
        while True:
            digits = f"{secrets.randbelow(10**15):015d}"
            candidate = format_orcid_id(digits + orcid_check_character(digits))
            if candidate not in _issued:
                _issued.add(candidate)
                return candidate
