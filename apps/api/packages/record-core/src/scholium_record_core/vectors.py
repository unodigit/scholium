"""Cross-language test vectors for the record core (``vectors/*.json``).

The vector files are the shared source of truth between language ports of
the record core:

* ``records.json`` -- every implementation must derive each vector's
  ``dag_cbor_hex`` and ``id`` from its ``envelope`` alone.
* ``signatures.json`` -- every implementation must derive each key's
  ``public_key_hex`` and ``did_key`` from its ``seed_hex`` alone, each
  vector's ``sig`` from its ``envelope`` and key's seed alone, accept
  every entry of ``vectors`` and reject every entry of ``invalid``
  (verification must return false).
* ``short_ids.json`` -- every implementation must derive each vector's
  ``short_id`` and ``version_ids`` from its ``genesis_cid`` alone, and
  reject every entry of ``invalid``.
* ``file_ids.json`` -- every implementation must derive each vector's
  ``digest_hex`` and ``cid`` from its ``bytes_hex`` alone, and reject
  every entry of ``invalid``.
* ``manifests.json`` -- every implementation must canonicalize each
  vector's ``body`` into ``files``, and reject every entry of
  ``invalid`` with the stated error kind.
* ``verification.json`` -- every implementation must derive each key's
  ``did_key`` from its ``seed_hex`` alone and each vector's ``records``,
  ``ids`` and ``call`` from its ``build`` and ``arguments`` alone, and
  ``verify_paper(records, **call)`` must produce each vector's ``expect``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from multiformats import CID
from nacl.signing import SigningKey

from .envelope import compute_record_id, record_bytes
from .file_id import compute_file_id
from .manifest import validate_manifest_body
from .short_id import derive_short_id, format_version_id
from .signing import (
    did_key_from_public_key,
    did_key_from_signing_key,
    sign_envelope,
    sign_record,
)


def refresh_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every vector's ``dag_cbor_hex`` and ``id`` in place.

    Only the expected outputs are rewritten; envelopes (including their
    illustrative ``id``/``sig`` members) are preserved verbatim.
    """
    for vector in doc["vectors"]:
        envelope = vector["envelope"]
        vector["dag_cbor_hex"] = record_bytes(envelope).hex()
        vector["id"] = compute_record_id(envelope)
    return doc


def refresh_signature_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every signature vector's derived outputs in place.

    Each key's ``public_key_hex`` and ``did_key`` are rewritten from its
    ``seed_hex``, and each vector's ``dag_cbor_hex`` and ``sig`` from its
    ``envelope`` and its key's seed.  Seeds, envelopes, the ``invalid``
    recipes and the ``invalid_did_keys`` inputs are preserved verbatim.
    """
    keys = {key["name"]: key for key in doc["keys"]}
    for key in doc["keys"]:
        seed = SigningKey(bytes.fromhex(key["seed_hex"]))
        key["public_key_hex"] = bytes(seed.verify_key).hex()
        key["did_key"] = did_key_from_public_key(bytes(seed.verify_key))
    for vector in doc["vectors"]:
        envelope = vector["envelope"]
        vector["dag_cbor_hex"] = record_bytes(envelope).hex()
        vector["sig"] = sign_envelope(
            envelope, bytes.fromhex(keys[vector["key"]]["seed_hex"])
        )
    return doc


def refresh_short_id_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every short id vector's expected outputs in place.

    ``digest_hex``, ``short_id`` and the values of ``version_ids`` are
    rewritten from ``genesis_cid``; the genesis CIDs, the version numbers
    (the keys of ``version_ids``) and the ``invalid`` inputs are preserved
    verbatim.
    """
    for vector in doc["vectors"]:
        genesis_cid = vector["genesis_cid"]
        short_id = derive_short_id(genesis_cid)
        vector["digest_hex"] = bytes(CID.decode(genesis_cid).raw_digest).hex()
        vector["short_id"] = short_id
        vector["version_ids"] = {
            number: format_version_id(short_id, int(number))
            for number in vector["version_ids"]
        }
    return doc


def refresh_file_id_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every file id vector's expected outputs in place.

    ``digest_hex`` and ``cid`` are rewritten from ``bytes_hex``; the
    ``bytes_hex`` inputs and the ``invalid`` inputs are preserved
    verbatim.
    """
    for vector in doc["vectors"]:
        data = bytes.fromhex(vector["bytes_hex"])
        vector["digest_hex"] = hashlib.sha256(data).hexdigest()
        vector["cid"] = compute_file_id(data)
    return doc


def refresh_manifest_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every manifest vector's canonical ``files`` in place.

    ``files`` is rewritten as :func:`validate_manifest_body` renders the
    vector's ``body``; the ``body`` inputs (which may carry scrambled
    key order) and the ``invalid`` inputs are preserved verbatim.
    """
    for vector in doc["vectors"]:
        vector["files"] = validate_manifest_body(vector["body"])["files"]
    return doc


#: ``created`` of a verification vector step that does not set its own.
VERIFICATION_CREATED = "2026-11-14T05:33:00Z"


def _resolve_placeholders(
    value: Any, ids: dict[str, str], dids: dict[str, str]
) -> Any:
    """Replace placeholder strings in a verification vector input.

    A string that is exactly ``$id:<ref>`` becomes that step's record id,
    ``$did:<key>`` that key's did:key, ``$sch:<ref>`` the short id derived
    from that step's record id and ``$sch:<ref>/<n>`` its version id.
    """
    if isinstance(value, str):
        if value.startswith("$id:"):
            return ids[value[len("$id:") :]]
        if value.startswith("$did:"):
            return dids[value[len("$did:") :]]
        if value.startswith("$sch:"):
            ref, _, number = value[len("$sch:") :].partition("/")
            short_id = derive_short_id(ids[ref])
            return format_version_id(short_id, int(number)) if number else short_id
        return value
    if isinstance(value, list):
        return [_resolve_placeholders(item, ids, dids) for item in value]
    if isinstance(value, dict):
        return {k: _resolve_placeholders(v, ids, dids) for k, v in value.items()}
    return value


def _set_path(target: Any, path: str, value: Any) -> None:
    *parents, last = path.split(".")
    for part in parents:
        target = target[int(part)] if isinstance(target, list) else target[part]
    if isinstance(target, list):
        target[int(last)] = value
    else:
        target[last] = value


def build_verification_records(
    keys: list[dict[str, Any]], steps: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Build the signed records of a verification vector from its steps.

    Each step is ``{"ref", "key", "type", "prev", "body"}`` (plus optional
    ``created`` and ``proofs``); the record is authored and signed by the
    named key, in order, so later steps can use ``$id:<ref>`` of earlier
    ones.  Three optional flags corrupt or drop it *after* signing:
    ``sign_with`` replaces the signature with one from another key,
    ``tamper`` sets dotted paths (``body.title``) leaving ``id`` and
    ``sig`` stale, and ``omit`` leaves the record out of the result.

    Returns the records and a ``ref -> record id`` map (of the untampered
    records, omitted ones included).
    """
    seeds = {key["name"]: bytes.fromhex(key["seed_hex"]) for key in keys}
    dids = {name: did_key_from_signing_key(seed) for name, seed in seeds.items()}
    ids: dict[str, str] = {}
    records: list[dict[str, Any]] = []
    for step in steps:
        envelope = {
            "v": 1,
            "type": step["type"],
            "author": dids[step["key"]],
            "created": step.get("created", VERIFICATION_CREATED),
            "prev": _resolve_placeholders(step.get("prev"), ids, dids),
            "body": _resolve_placeholders(step["body"], ids, dids),
            "proofs": step.get("proofs", []),
        }
        record = sign_record(envelope, seeds[step["key"]])
        ids[step["ref"]] = record["id"]
        if "sign_with" in step:
            record["sig"] = sign_envelope(envelope, seeds[step["sign_with"]])
        for path, value in step.get("tamper", {}).items():
            _set_path(record, path, _resolve_placeholders(value, ids, dids))
        if not step.get("omit"):
            records.append(record)
    return records, ids


def refresh_verification_vectors(doc: dict[str, Any]) -> dict[str, Any]:
    """Recompute every verification vector's generated inputs in place.

    Each key's ``did_key`` is rewritten from its ``seed_hex``; each
    vector's ``records`` and ``ids`` from its ``build`` steps and its
    ``call`` from ``arguments``.  The ``build`` steps, ``arguments`` and
    hand-written ``expect`` are preserved verbatim, so ``expect`` is a
    claim about the implementation, not output of it.
    """
    for key in doc["keys"]:
        key["did_key"] = did_key_from_signing_key(bytes.fromhex(key["seed_hex"]))
    dids = {key["name"]: key["did_key"] for key in doc["keys"]}
    for vector in doc["vectors"]:
        records, ids = build_verification_records(doc["keys"], vector["build"])
        vector["records"] = records
        vector["ids"] = ids
        vector["call"] = _resolve_placeholders(vector["arguments"], ids, dids)
    return doc


def dumps_vectors(doc: dict[str, Any]) -> str:
    """Serialize a vector document to its stable on-disk text form."""
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def load_vectors(path: str | Path) -> dict[str, Any]:
    """Load a vector document from ``path``."""
    return json.loads(Path(path).read_text(encoding="utf-8"))
