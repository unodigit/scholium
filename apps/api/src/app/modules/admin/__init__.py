"""Admin tools plugin: operator commands run as ``python -m app.modules.admin``.

``set-tier <did> <tier>`` sets an account's trust tier and prints the new one.
The plugin exposes no HTTP routes, so the module loader mounts nothing for it.
"""

from .service import InvalidDid, TierChange, parse_tier, set_tier, validate_did

__all__ = ["InvalidDid", "TierChange", "parse_tier", "set_tier", "validate_did"]
