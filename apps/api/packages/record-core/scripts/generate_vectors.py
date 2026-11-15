#!/usr/bin/env python3
"""Regenerate the cross-language record id test vectors.

Refreshes the expected ``dag_cbor_hex`` and ``id`` of every entry in
``vectors/records.json`` from the current record id implementation.
Envelope inputs (and their illustrative ``id``/``sig`` members) are kept
verbatim, so a run is idempotent unless the implementation changes.

Usage (from ``apps/api``)::

    uv run --all-packages python packages/record-core/scripts/generate_vectors.py
    uv run --all-packages python packages/record-core/scripts/generate_vectors.py --check
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from scholium_record_core.vectors import dumps_vectors, load_vectors, refresh_vectors

VECTORS_PATH = Path(__file__).resolve().parents[1] / "vectors" / "records.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the file is up to date instead of rewriting it",
    )
    args = parser.parse_args(argv)

    current = VECTORS_PATH.read_text(encoding="utf-8")
    doc = load_vectors(VECTORS_PATH)
    updated = dumps_vectors(refresh_vectors(doc))

    if updated == current:
        print(f"{VECTORS_PATH} is up to date ({len(doc['vectors'])} vectors)")
        return 0
    if args.check:
        print(
            f"{VECTORS_PATH} is out of date; re-run without --check",
            file=sys.stderr,
        )
        return 1
    VECTORS_PATH.write_text(updated, encoding="utf-8")
    print(f"wrote {VECTORS_PATH} ({len(doc['vectors'])} vectors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
