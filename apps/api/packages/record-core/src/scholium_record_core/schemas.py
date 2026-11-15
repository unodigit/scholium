"""Record body validation against the JSON Schemas in ``schemas/``.

Every Phase 1 record type has a body schema shipped as
``schemas/<record-type>.json`` next to this package.  The schemas are
ordinary JSON Schema draft 2020-12 documents; this module provides a
small, dependency-free validator for the subset of JSON Schema they use
(``type``, ``properties``, ``required``, ``additionalProperties``,
``items``, ``enum``, ``const``, ``pattern``, numeric and length bounds,
``allOf``/``anyOf``/``oneOf``/``not``, ``if``/``then``/``else`` and local
``$ref``), so the record core has no third-party validation dependency.

The public entry points deliberately return a *list of error messages*
rather than raising on an invalid body::

    >>> validate_body("review.rating", {"review": "bafy...", "rating": 6})
    ["body.rating: 6 is greater than the maximum of 5"]

An empty list means the body is valid.  Unknown record types are
reported as an error message as well; only schema lookup itself
(:func:`load_schema`) raises :class:`UnknownRecordTypeError`.
"""

from __future__ import annotations

import copy
import json
import math
import os
import re
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from .envelope import canonical_envelope

#: Every Phase 1 record type, in the order the product spec lists them.
RECORD_TYPES: tuple[str, ...] = (
    "paper.genesis",
    "paper.version",
    "manifest",
    "coauthor.consent",
    "review.commit",
    "review.formal",
    "review.response",
    "review.rating",
    "discussion.post",
    "ai.review",
    "rendition",
    "endorsement",
    "moderation.decision",
    "appeal",
    "appeal.decision",
    "retraction",
    "correction",
    "withdrawal",
    "key.rotation",
    "erasure.request",
    "external.mirror",
    "flag",
)

#: Alias kept for callers that read the tuple as a supported-type list.
SUPPORTED_RECORD_TYPES = RECORD_TYPES

#: Maximum nesting depth followed through ``$ref`` before giving up.
_MAX_DEPTH = 80

_DATE_TIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?"
    r"(?:[Zz]|[+-]\d{2}:?\d{2})?$"
)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_URI_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_DID_RE = re.compile(r"^did:[a-z0-9]+:.+$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_SCHEMA_CACHE: dict[Path, tuple[int, dict[str, Any]]] = {}


class UnknownRecordTypeError(KeyError, ValueError):
    """Raised when a schema is requested for an unsupported record type.

    It subclasses both :class:`KeyError` and :class:`ValueError` so
    callers can catch whichever they consider natural.
    """

    def __init__(self, record_type: Any) -> None:
        self.record_type = record_type
        super().__init__(record_type)

    def __str__(self) -> str:  # KeyError would add quotes around the message
        return f"unknown record type: {self.record_type!r}"


class RecordValidationError(ValueError):
    """Raised by :func:`assert_valid_body` with all validation errors."""

    def __init__(self, record_type: str, errors: list[str]) -> None:
        self.record_type = record_type
        self.errors = list(errors)
        super().__init__(
            f"invalid {record_type} body: " + "; ".join(self.errors)
        )


def _default_schema_dir() -> Path:
    """Locate the shipped ``schemas/`` directory.

    Order: the ``SCHOLIUM_SCHEMA_DIR`` environment override, the
    repository package layout (``packages/record-core/schemas``), then
    the copy installed into the wheel under ``record_schemas/``.
    """

    override = os.environ.get("SCHOLIUM_SCHEMA_DIR")
    if override:
        return Path(override)
    repo_layout = Path(__file__).resolve().parents[2] / "schemas"
    if repo_layout.is_dir():
        return repo_layout
    packaged = Path(__file__).resolve().parent / "record_schemas"
    if packaged.is_dir():
        return packaged
    return repo_layout


#: Location of the schema files resolved at import time.
SCHEMA_DIR: Path = _default_schema_dir()


def schema_dir() -> Path:
    """Return the schema directory, honouring ``SCHOLIUM_SCHEMA_DIR``."""

    return _default_schema_dir()


def schema_path(
    record_type: str, *, schema_dir: str | Path | None = None
) -> Path:
    """Return the path of ``record_type``'s schema file.

    Raises:
        UnknownRecordTypeError: if ``record_type`` is not a Phase 1 type.
    """

    if record_type not in RECORD_TYPES:
        raise UnknownRecordTypeError(record_type)
    directory = Path(schema_dir) if schema_dir is not None else _default_schema_dir()
    return directory / f"{record_type}.json"


def load_schema(
    record_type: str, *, schema_dir: str | Path | None = None
) -> dict[str, Any]:
    """Load and return the body schema for ``record_type``.

    The returned document is a deep copy, so callers can mutate it
    without affecting later validations.

    Raises:
        UnknownRecordTypeError: if ``record_type`` is unsupported.
        FileNotFoundError: if the shipped schema file is missing.
    """

    path = schema_path(record_type, schema_dir=schema_dir)
    try:
        resolved = path.resolve()
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError as exc:  # pragma: no cover - packaging error
        raise FileNotFoundError(
            f"no JSON Schema shipped for record type {record_type!r}: {path}"
        ) from exc

    cached = _SCHEMA_CACHE.get(resolved)
    if cached is not None and cached[0] == mtime:
        return copy.deepcopy(cached[1])

    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise ValueError(f"schema {path} must contain a JSON object")
    _SCHEMA_CACHE[resolved] = (mtime, document)
    return copy.deepcopy(document)


#: Descriptive aliases for callers that prefer another verb.
schema_for = load_schema
get_schema = load_schema


def load_all_schemas(
    *, schema_dir: str | Path | None = None
) -> dict[str, dict[str, Any]]:
    """Return every body schema keyed by record type."""

    return {
        record_type: load_schema(record_type, schema_dir=schema_dir)
        for record_type in RECORD_TYPES
    }


#: Alias for :func:`load_all_schemas`.
all_schemas = load_all_schemas


def list_record_types() -> list[str]:
    """Return the supported Phase 1 record types as a list."""

    return list(RECORD_TYPES)


def available_types() -> list[str]:
    """Alias for :func:`list_record_types`."""

    return list_record_types()


def has_schema(record_type: object) -> bool:
    """Return whether ``record_type`` is a supported Phase 1 type."""

    return isinstance(record_type, str) and record_type in RECORD_TYPES


# ---------------------------------------------------------------------------
# JSON Schema evaluation
# ---------------------------------------------------------------------------


def _json_equal(left: Any, right: Any) -> bool:
    """JSON equality, keeping booleans distinct from 0 and 1."""

    if isinstance(left, bool) or isinstance(right, bool):
        return (
            isinstance(left, bool)
            and isinstance(right, bool)
            and left == right
        )
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        if set(left) != set(right):
            return False
        return all(_json_equal(left[key], right[key]) for key in left)
    if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
        return len(left) == len(right) and all(
            _json_equal(a, b) for a, b in zip(left, right)
        )
    return type(left) is type(right) and left == right


def _freeze(value: Any) -> Any:
    """Return a hashable form of a JSON value for ``uniqueItems``."""

    if isinstance(value, Mapping):
        return (
            "object",
            tuple(sorted((str(k), _freeze(v)) for k, v in value.items())),
        )
    if isinstance(value, (list, tuple)):
        return ("array", tuple(_freeze(item) for item in value))
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, (int, float)):
        return ("number", float(value))
    if value is None:
        return ("null", None)
    return ("string", str(value))


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, Mapping):
        return "object"
    if isinstance(value, (list, tuple)):
        return "array"
    return type(value).__name__


def _is_type(value: Any, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "object":
        return isinstance(value, Mapping)
    if expected == "array":
        return isinstance(value, (list, tuple))
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        if isinstance(value, bool):
            return False
        if isinstance(value, int):
            return True
        return (
            isinstance(value, float)
            and math.isfinite(value)
            and value.is_integer()
        )
    if expected == "number":
        return (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
        )
    # An unknown type keyword is a schema authoring error; do not turn it
    # into a body error.
    return True


def _matches_format(value: str, fmt: str) -> bool:
    if fmt == "date-time":
        return bool(_DATE_TIME_RE.match(value))
    if fmt == "date":
        return bool(_DATE_RE.match(value))
    if fmt in ("uri", "uri-reference"):
        return bool(_URI_RE.match(value))
    if fmt == "did":
        return bool(_DID_RE.match(value))
    if fmt == "email":
        return bool(_EMAIL_RE.match(value))
    # Other formats are annotations only.
    return True


def _child(path: str, key: str) -> str:
    return f"{path}.{key}" if path else str(key)


def _index(path: str, position: int) -> str:
    return f"{path}[{position}]" if path else f"[{position}]"


def _short(value: Any, limit: int = 80) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except (TypeError, ValueError):  # pragma: no cover - odd input values
        text = repr(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _resolve_ref(root: Any, ref: str) -> Any:
    """Resolve a local JSON pointer ``$ref`` against ``root``."""

    if not isinstance(ref, str) or not ref.startswith("#"):
        raise ValueError(f"only local $ref pointers are supported, got {ref!r}")
    pointer = ref[1:]
    if pointer in ("", "/"):
        return root
    if not pointer.startswith("/"):
        raise ValueError(f"malformed JSON pointer {ref!r}")

    current = root
    for raw_token in pointer[1:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, Mapping):
            if token not in current:
                raise KeyError(f"missing pointer segment {token!r} in {ref!r}")
            current = current[token]
        elif isinstance(current, (list, tuple)) and token.isdigit():
            current = current[int(token)]
        else:
            raise KeyError(f"cannot follow pointer segment {token!r} in {ref!r}")
    return current


def _describe_alternative(alternative: Any) -> str:
    if alternative is True:
        return "true"
    if alternative is False:
        return "false"
    if not isinstance(alternative, Mapping):
        return "alternative"
    parts: list[str] = []
    if "$ref" in alternative:
        parts.append(f"$ref {alternative['$ref']}")
    required = alternative.get("required")
    if isinstance(required, list) and required:
        parts.append("requires " + ", ".join(str(item) for item in required))
    expected = alternative.get("type")
    if isinstance(expected, str):
        parts.append(f"type {expected}")
    elif isinstance(expected, list):
        parts.append("type " + "/".join(str(item) for item in expected))
    if "const" in alternative:
        parts.append(f"const {_short(alternative['const'])}")
    if isinstance(alternative.get("enum"), list):
        parts.append(f"one of {_short(alternative['enum'])}")
    return "; ".join(parts) or "alternative"


def _candidate_detail(errors: list[str], path: str) -> str:
    """Shorten nested alternative errors for an ``anyOf``/``oneOf`` message."""

    prefix = f"{path}: "
    details: list[str] = []
    for error in errors:
        details.append(error[len(prefix):] if error.startswith(prefix) else error)
    return "; ".join(details)


def _alternative_details(
    value: Any,
    alternatives: list[Any],
    path: str,
    root: Any,
    depth: int,
) -> str:
    rendered: list[str] = []
    for alternative in alternatives:
        candidate: list[str] = []
        _validate(value, alternative, path, candidate, root, depth + 1)
        description = _describe_alternative(alternative)
        detail = _candidate_detail(candidate, path)
        rendered.append(f"{description} [{detail}]" if detail else description)
    return ", ".join(rendered)


def _validate(
    value: Any,
    schema: Any,
    path: str,
    errors: list[str],
    root: Any,
    depth: int = 0,
) -> None:
    """Append human-readable errors for ``value`` against ``schema``."""

    if depth > _MAX_DEPTH:
        errors.append(f"{path}: schema recursion is too deep")
        return
    if schema is True:
        return
    if schema is False:
        errors.append(f"{path}: value is not allowed")
        return
    if not isinstance(schema, Mapping):
        errors.append(f"{path}: invalid schema node {type(schema).__name__}")
        return

    if "$ref" in schema:
        try:
            target = _resolve_ref(root, schema["$ref"])
        except (KeyError, ValueError) as exc:
            errors.append(f"{path}: cannot resolve {schema['$ref']!r}: {exc}")
        else:
            _validate(value, target, path, errors, root, depth + 1)

    if "type" in schema:
        expected = schema["type"]
        accepted = (
            [expected] if isinstance(expected, str) else list(expected)
            if isinstance(expected, (list, tuple))
            else []
        )
        if accepted and not any(
            _is_type(value, item) for item in accepted if isinstance(item, str)
        ):
            errors.append(
                f"{path}: expected {' or '.join(accepted)}, "
                f"got {_type_name(value)}"
            )

    if "const" in schema and not _json_equal(value, schema["const"]):
        errors.append(
            f"{path}: expected {_short(schema['const'])}, got {_short(value)}"
        )

    if isinstance(schema.get("enum"), list):
        if not any(_json_equal(value, option) for option in schema["enum"]):
            errors.append(
                f"{path}: {_short(value)} is not one of "
                f"{_short(schema['enum'])}"
            )

    for alternative in schema.get("allOf", []) or []:
        _validate(value, alternative, path, errors, root, depth + 1)

    if isinstance(schema.get("anyOf"), list):
        alternatives = schema["anyOf"]
        matched = False
        for alternative in alternatives:
            candidate: list[str] = []
            _validate(value, alternative, path, candidate, root, depth + 1)
            if not candidate:
                matched = True
                break
        if not matched:
            errors.append(
                f"{path}: does not match any allowed alternative ("
                + _alternative_details(
                    value, alternatives, path, root, depth
                )
                + ")"
            )

    if isinstance(schema.get("oneOf"), list):
        alternatives = schema["oneOf"]
        matches = 0
        for alternative in alternatives:
            candidate = []
            _validate(value, alternative, path, candidate, root, depth + 1)
            if not candidate:
                matches += 1
        if matches == 0:
            errors.append(
                f"{path}: does not match any allowed alternative ("
                + _alternative_details(
                    value, alternatives, path, root, depth
                )
                + ")"
            )
        elif matches > 1:
            errors.append(
                f"{path}: matches more than one exclusive alternative"
            )

    if "not" in schema:
        candidate = []
        _validate(value, schema["not"], path, candidate, root, depth + 1)
        if not candidate:
            errors.append(f"{path}: value is not allowed by the schema")

    if "if" in schema:
        condition = []
        _validate(value, schema["if"], path, condition, root, depth + 1)
        branch = schema.get("then") if not condition else schema.get("else")
        if branch is not None:
            _validate(value, branch, path, errors, root, depth + 1)

    if isinstance(value, str):
        minimum_length = schema.get("minLength")
        if isinstance(minimum_length, int) and len(value) < minimum_length:
            errors.append(
                f"{path}: string is shorter than the minimum length "
                f"{minimum_length}"
            )
        maximum_length = schema.get("maxLength")
        if isinstance(maximum_length, int) and len(value) > maximum_length:
            errors.append(
                f"{path}: string is longer than the maximum length "
                f"{maximum_length}"
            )
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            try:
                matched = re.search(pattern, value) is not None
            except re.error:
                matched = True
            if not matched:
                errors.append(
                    f"{path}: {_short(value)} does not match pattern "
                    f"'{pattern}'"
                )
        fmt = schema.get("format")
        if isinstance(fmt, str) and not _matches_format(value, fmt):
            errors.append(f"{path}: {_short(value)} is not a valid {fmt}")

    if (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    ):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and value < minimum:
            errors.append(f"{path}: {value} is less than the minimum {minimum}")
        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and value > maximum:
            errors.append(
                f"{path}: {value} is greater than the maximum {maximum}"
            )
        exclusive_minimum = schema.get("exclusiveMinimum")
        if (
            isinstance(exclusive_minimum, (int, float))
            and value <= exclusive_minimum
        ):
            errors.append(
                f"{path}: {value} must be greater than {exclusive_minimum}"
            )
        exclusive_maximum = schema.get("exclusiveMaximum")
        if (
            isinstance(exclusive_maximum, (int, float))
            and value >= exclusive_maximum
        ):
            errors.append(
                f"{path}: {value} must be less than {exclusive_maximum}"
            )
        multiple_of = schema.get("multipleOf")
        if isinstance(multiple_of, (int, float)) and multiple_of:
            quotient = value / multiple_of
            if not math.isclose(quotient, round(quotient), abs_tol=1e-9):
                errors.append(
                    f"{path}: {value} is not a multiple of {multiple_of}"
                )

    if isinstance(value, (list, tuple)):
        minimum_items = schema.get("minItems")
        if isinstance(minimum_items, int) and len(value) < minimum_items:
            errors.append(
                f"{path}: array has fewer than the minimum of "
                f"{minimum_items} item(s)"
            )
        maximum_items = schema.get("maxItems")
        if isinstance(maximum_items, int) and len(value) > maximum_items:
            errors.append(
                f"{path}: array has more than the maximum of "
                f"{maximum_items} item(s)"
            )
        if schema.get("uniqueItems") is True:
            seen: set[Any] = set()
            for item in value:
                marker = _freeze(item)
                if marker in seen:
                    errors.append(
                        f"{path}: array items are not unique "
                        f"({_short(item)} repeats)"
                    )
                    break
                seen.add(marker)

        prefix_items = schema.get("prefixItems")
        if isinstance(prefix_items, list):
            for position, sub_schema in enumerate(prefix_items):
                if position < len(value):
                    _validate(
                        value[position],
                        sub_schema,
                        _index(path, position),
                        errors,
                        root,
                        depth + 1,
                    )
            extra_schema = schema.get("items", True)
            if extra_schema is False:
                for position in range(len(prefix_items), len(value)):
                    errors.append(
                        f"{_index(path, position)}: unexpected item"
                    )
            elif isinstance(extra_schema, Mapping):
                for position in range(len(prefix_items), len(value)):
                    _validate(
                        value[position],
                        extra_schema,
                        _index(path, position),
                        errors,
                        root,
                        depth + 1,
                    )
        elif "items" in schema:
            item_schema = schema["items"]
            if item_schema is False and value:
                errors.append(f"{path}: items are not allowed")
            elif isinstance(item_schema, Mapping):
                for position, item in enumerate(value):
                    _validate(
                        item,
                        item_schema,
                        _index(path, position),
                        errors,
                        root,
                        depth + 1,
                    )

        if "contains" in schema:
            matches = 0
            for position, item in enumerate(value):
                candidate = []
                _validate(
                    item,
                    schema["contains"],
                    _index(path, position),
                    candidate,
                    root,
                    depth + 1,
                )
                if not candidate:
                    matches += 1
            minimum_contains = schema.get("minContains", 1)
            if (
                isinstance(minimum_contains, int)
                and matches < minimum_contains
            ):
                errors.append(
                    f"{path}: array must contain at least "
                    f"{minimum_contains} matching item(s)"
                )
            maximum_contains = schema.get("maxContains")
            if (
                isinstance(maximum_contains, int)
                and matches > maximum_contains
            ):
                errors.append(
                    f"{path}: array must contain at most "
                    f"{maximum_contains} matching item(s)"
                )

    if isinstance(value, Mapping):
        minimum_properties = schema.get("minProperties")
        if (
            isinstance(minimum_properties, int)
            and len(value) < minimum_properties
        ):
            errors.append(
                f"{path}: object has fewer than the minimum of "
                f"{minimum_properties} properties"
            )
        maximum_properties = schema.get("maxProperties")
        if (
            isinstance(maximum_properties, int)
            and len(value) > maximum_properties
        ):
            errors.append(
                f"{path}: object has more than the maximum of "
                f"{maximum_properties} properties"
            )

        required = schema.get("required")
        if isinstance(required, list):
            for property_name in required:
                if property_name not in value:
                    errors.append(
                        f"{path}: missing required property "
                        f"{property_name!r}"
                    )

        properties = schema.get("properties")
        properties = properties if isinstance(properties, Mapping) else {}
        known: set[str] = set()
        for property_name, sub_schema in properties.items():
            known.add(property_name)
            if property_name in value:
                _validate(
                    value[property_name],
                    sub_schema,
                    _child(path, str(property_name)),
                    errors,
                    root,
                    depth + 1,
                )

        pattern_properties = schema.get("patternProperties")
        if isinstance(pattern_properties, Mapping):
            for pattern, sub_schema in pattern_properties.items():
                try:
                    regex = re.compile(pattern)
                except re.error:  # pragma: no cover - schema authoring error
                    continue
                for property_name, property_value in value.items():
                    if regex.search(str(property_name)):
                        known.add(str(property_name))
                        _validate(
                            property_value,
                            sub_schema,
                            _child(path, str(property_name)),
                            errors,
                            root,
                            depth + 1,
                        )

        if "additionalProperties" in schema:
            additional = schema["additionalProperties"]
            for property_name in sorted(
                (key for key in value if str(key) not in known), key=str
            ):
                location = _child(path, str(property_name))
                if additional is False:
                    errors.append(
                        f"{location}: unexpected property "
                        f"{property_name!r}"
                    )
                elif isinstance(additional, Mapping):
                    _validate(
                        value[property_name],
                        additional,
                        location,
                        errors,
                        root,
                        depth + 1,
                    )

        property_names = schema.get("propertyNames")
        if isinstance(property_names, Mapping):
            for property_name in value:
                _validate(
                    str(property_name),
                    property_names,
                    _child(path, f"<{property_name}>"),
                    errors,
                    root,
                    depth + 1,
                )

        dependent_required = schema.get("dependentRequired")
        if isinstance(dependent_required, Mapping):
            for property_name, requirements in dependent_required.items():
                if property_name not in value:
                    continue
                if not isinstance(requirements, list):
                    continue
                for requirement in requirements:
                    if requirement not in value:
                        errors.append(
                            f"{path}: property {property_name!r} requires "
                            f"property {requirement!r}"
                        )


# ---------------------------------------------------------------------------
# Public validation helpers
# ---------------------------------------------------------------------------


def _normalize_arguments(record_type: Any, body: Any) -> tuple[Any, Any]:
    """Accept both ``(record_type, body)`` and a swapped ``(body, type)``."""

    if isinstance(record_type, Mapping) and isinstance(body, str):
        return body, record_type
    return record_type, body


def validate_body(
    record_type: str,
    body: Any,
    *,
    schema_dir: str | Path | None = None,
) -> list[str]:
    """Validate ``body`` against the schema for ``record_type``.

    Returns a list of error messages, empty when the body is valid.  An
    unknown record type or a non-object body is reported as a single
    error rather than raising.
    """

    record_type, body = _normalize_arguments(record_type, body)

    if not isinstance(record_type, str) or record_type not in RECORD_TYPES:
        return [f"unknown record type: {record_type!r}"]
    if not isinstance(body, Mapping):
        return [
            f"body must be a JSON object, got {_type_name(body)}"
        ]

    schema = load_schema(record_type, schema_dir=schema_dir)
    errors: list[str] = []
    _validate(dict(body), schema, "body", errors, schema)
    return errors


#: Short aliases used by API modules and other callers.
validate_record_body = validate_body
validate_body_errors = validate_body

_MISSING = object()


def validate(
    record_type_or_record: Any,
    body: Any = _MISSING,
    *,
    schema_dir: str | Path | None = None,
) -> list[str]:
    """Validate a body or a whole record envelope.

    ``validate(record_type, body)`` is :func:`validate_body`;
    ``validate(record)`` is :func:`validate_record`.
    """

    if body is _MISSING:
        return validate_record(record_type_or_record, schema_dir=schema_dir)
    return validate_body(
        record_type_or_record, body, schema_dir=schema_dir
    )


def is_valid_body(
    record_type: str,
    body: Any,
    *,
    schema_dir: str | Path | None = None,
) -> bool:
    """Return ``True`` when ``body`` validates without errors."""

    return not validate_body(record_type, body, schema_dir=schema_dir)


def assert_valid_body(
    record_type: str,
    body: Any,
    *,
    schema_dir: str | Path | None = None,
) -> None:
    """Raise :class:`RecordValidationError` when ``body`` is invalid."""

    errors = validate_body(record_type, body, schema_dir=schema_dir)
    if errors:
        raise RecordValidationError(record_type, errors)


def validate_record(
    record: Any,
    *,
    schema_dir: str | Path | None = None,
) -> list[str]:
    """Validate the ``body`` of a signed record envelope.

    The envelope's ``type`` selects the body schema.  Only the body is
    validated here; :func:`validate_envelope` additionally checks the
    seven canonical envelope fields.
    """

    if not isinstance(record, Mapping):
        return [
            f"record must be a JSON object, got {_type_name(record)}"
        ]
    if "type" not in record:
        return ["record: missing required property 'type'"]
    record_type = record["type"]
    if not isinstance(record_type, str) or not record_type:
        return [
            f"record.type: expected string, got {_type_name(record_type)}"
        ]
    if record_type not in RECORD_TYPES:
        return [f"unknown record type: {record_type!r}"]
    if "body" not in record:
        return [
            f"record: {record_type} record is missing required property "
            f"'body'"
        ]
    body = record["body"]
    if not isinstance(body, Mapping):
        return [
            f"record.body: expected object, got {_type_name(body)}"
        ]
    return validate_body(record_type, body, schema_dir=schema_dir)


def validate_envelope(
    record: Any,
    *,
    schema_dir: str | Path | None = None,
) -> list[str]:
    """Validate the envelope fields and the body of ``record``.

    Envelope errors name the failing canonical field (``v``, ``type``,
    ``author``, ``created``, ``prev``, ``body`` or ``proofs``); body
    errors are those of :func:`validate_body`.
    """

    if not isinstance(record, Mapping):
        return [
            f"record must be a JSON object, got {_type_name(record)}"
        ]

    errors: list[str] = []
    try:
        canonical_envelope(record)
    except ValueError as exc:
        errors.append(f"envelope: {exc}")
    errors.extend(validate_record(record, schema_dir=schema_dir))
    return errors


def _iter_refs(value: Any) -> Iterator[str]:
    if isinstance(value, Mapping):
        ref = value.get("$ref")
        if isinstance(ref, str):
            yield ref
        for item in value.values():
            yield from _iter_refs(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_refs(item)


def check_schemas(
    *, schema_dir: str | Path | None = None
) -> list[str]:
    """Check that every shipped schema loads and is structurally sound.

    Returns a list of problems, empty when every Phase 1 schema exists,
    parses, declares the expected top-level fields and has only
    resolvable local ``$ref`` pointers.
    """

    errors: list[str] = []
    for record_type in RECORD_TYPES:
        try:
            schema = load_schema(record_type, schema_dir=schema_dir)
        except (OSError, ValueError) as exc:
            errors.append(f"{record_type}: cannot load schema: {exc}")
            continue

        if not isinstance(schema.get("$schema"), str):
            errors.append(f"{record_type}: missing '$schema'")
        if schema.get("type") != "object":
            errors.append(f"{record_type}: top-level type must be 'object'")
        properties = schema.get("properties")
        if not isinstance(properties, Mapping):
            errors.append(f"{record_type}: missing 'properties' object")
            properties = {}
        required = schema.get("required")
        if not isinstance(required, list) or not required:
            errors.append(f"{record_type}: missing non-empty 'required' list")
            required = []
        for property_name in required:
            if property_name not in properties:
                errors.append(
                    f"{record_type}: required property {property_name!r} "
                    f"is not declared in 'properties'"
                )
        for ref in _iter_refs(schema):
            try:
                _resolve_ref(schema, ref)
            except (KeyError, ValueError) as exc:
                errors.append(
                    f"{record_type}: unresolvable $ref {ref!r}: {exc}"
                )
    return errors


__all__ = [
    "RECORD_TYPES",
    "SUPPORTED_RECORD_TYPES",
    "SCHEMA_DIR",
    "RecordValidationError",
    "UnknownRecordTypeError",
    "assert_valid_body",
    "available_types",
    "check_schemas",
    "get_schema",
    "has_schema",
    "is_valid_body",
    "list_record_types",
    "load_all_schemas",
    "load_schema",
    "all_schemas",
    "schema_dir",
    "schema_for",
    "schema_path",
    "validate",
    "validate_body",
    "validate_body_errors",
    "validate_envelope",
    "validate_record",
    "validate_record_body",
]
