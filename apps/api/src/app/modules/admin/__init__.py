"""Admin tools plugin: operator commands run as ``python -m app.modules.admin``.

``set-tier <did> <tier>`` sets an account's trust tier and prints the new one.

``seed-demo`` loads fictional demo data -- authors, reviewers, a moderator and
papers -- by signing every record with keys it writes to ``.demo-keys.json`` and
submitting them to the node's own API, then prints the papers' ``sch:`` ids.  The
code for it lives in :mod:`app.modules.admin.demo` and is only imported by that
command.

The plugin exposes no HTTP routes, so the module loader mounts nothing for it.
"""

from .service import InvalidDid, TierChange, parse_tier, set_tier, validate_did

__all__ = ["InvalidDid", "TierChange", "parse_tier", "set_tier", "validate_did"]
