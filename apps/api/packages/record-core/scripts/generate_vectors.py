#!/usr/bin/env python3
"""Regenerate the cross-language test vectors.

Refreshes the expected outputs of every entry in ``vectors/records.json``
(``dag_cbor_hex`` and ``id``), ``vectors/signatures.json`` (each key's
``public_key_hex`` and ``did_key``, each vector's ``dag_cbor_hex`` and
``sig``), ``vectors/short_ids.json``
(``digest_hex``, ``short_id`` and ``version_ids``),
``vectors/file_ids.json`` (``digest_hex`` and ``cid``) and
``vectors/manifests.json`` (``files``) from the current implementation.
Inputs (envelopes with their illustrative ``id``/``sig`` members, key
seeds, genesis CIDs, invalid strings, recipes and bodies) are kept
verbatim, so a run is idempotent unless the implementation changes.

Usage (from ``apps/api``)::

    uv run --all-packages python packages/record-core/scripts/generate_vectors.py
    uv run --all-packages python packages/record-core/scripts/generate_vectors.py --check
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from scholium_record_core.vectors import (
    dumps_vectors,
    load_vectors,
    refresh_file_id_vectors,
    refresh_manifest_vectors,
    refresh_short_id_vectors,
    refresh_signature_vectors,
    refresh_vectors,
)

VECTORS_DIR = Path(__file__).resolve().parents[1] / "vectors"

TARGETS: tuple[tuple[Path, Callable[[dict[str, Any]], dict[str, Any]]], ...] = (
    (VECTORS_DIR / "records.json", refresh_vectors),
    (VECTORS_DIR / "signatures.json", refresh_signature_vectors),
    (VECTORS_DIR / "short_ids.json", refresh_short_id_vectors),
    (VECTORS_DIR / "file_ids.json", refresh_file_id_vectors),
    (VECTORS_DIR / "manifests.json", refresh_manifest_vectors),
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the files are up to date instead of rewriting them",
    )
    args = parser.parse_args(argv)

    status = 0
    for path, refresh in TARGETS:
        current = path.read_text(encoding="utf-8")
        doc = load_vectors(path)
        updated = dumps_vectors(refresh(doc))

        if updated == current:
            print(f"{path} is up to date ({len(doc['vectors'])} vectors)")
        elif args.check:
            print(
                f"{path} is out of date; re-run without --check",
                file=sys.stderr,
            )
            status = 1
        else:
            path.write_text(updated, encoding="utf-8")
            print(f"wrote {path} ({len(doc['vectors'])} vectors)")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
