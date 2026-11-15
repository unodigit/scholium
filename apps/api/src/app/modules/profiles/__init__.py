"""Profiles & erasure module (plugin: profiles).

Feature 28: ``PUT /v1/profiles/{did}`` lets a user save their name, affiliation
and email.  The three fields are encrypted with a per-object AES-256-GCM key
into ``profile.enc_blob``, and the key is held in the ``profile_keys`` table, so
that erasing a profile later is just deleting its key (crypto-shredding).

Personal data lives nowhere else: records reference DIDs only.

The module loader discovers packages under ``app.modules`` automatically.
Importing this package registers the models on the shared declarative base
before ``create_app`` creates tables, and the ``router`` exported here is
mounted under ``/v1``.
"""

from __future__ import annotations

from .crypto import ProfileDecryptionError, open_profile, seal_profile
from .models import Profile, ProfileKey, ensure_tables
from .router import router
from .schemas import ProfileIn, ProfileOut
from .service import ProfileData, read_profile, save_profile

__all__ = [
    "Profile",
    "ProfileData",
    "ProfileDecryptionError",
    "ProfileIn",
    "ProfileKey",
    "ProfileOut",
    "ensure_tables",
    "open_profile",
    "read_profile",
    "router",
    "save_profile",
    "seal_profile",
]
