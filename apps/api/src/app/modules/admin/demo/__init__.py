"""Demo data for a development node (``python -m app.modules.admin seed-demo``).

Nothing here is imported by ``app.modules.admin`` itself, so the app and the
``set-tier`` command start without any of it.  Importing this package makes sure
the record core is importable first (see :mod:`app.modules.admin.bootstrap`), so
every module in it may import ``scholium_record_core`` directly.

* :mod:`.cast` -- the fictional people and papers, as plain data;
* :mod:`.keys` -- ``.demo-keys.json``: each demo account's Ed25519 key;
* :mod:`.manuscript` -- the demo manuscripts, as small deterministic PDFs;
* :mod:`.seed` -- :func:`seed_demo`, which acts as those people against the API.
"""

from ..bootstrap import ensure_record_core

ensure_record_core()
