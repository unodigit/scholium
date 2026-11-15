"""Load the moderation policy clauses from policies.yaml.

The clauses are the public moderation policies a moderator must cite when
recording a decision; they are served by GET /v1/moderation/policies.
The default source is the ``policies.yaml`` bundled next to this module.
Point ``MODERATION_POLICIES_YAML`` (alias ``POLICIES_YAML``) at another
file to override it.

PyYAML is used when it is installed. Otherwise a small parser for the
subset of YAML the policy file uses — nested mappings, lists of mappings,
plain/quoted single-line scalars and literal/folded block scalars — keeps
this plugin dependency-free. Both parsers accept the same shipped file.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field

DEFAULT_POLICIES_FILE = "policies.yaml"
POLICIES_YAML_ENV = "MODERATION_POLICIES_YAML"
POLICIES_YAML_ENV_ALIASES = (POLICIES_YAML_ENV, "POLICIES_YAML")

_CLAUSE_KEYS = ("id", "title", "text")


class PolicyClauseError(ValueError):
    """Raised when the policies file is missing, unparsable or invalid."""


class PolicyClause(BaseModel):
    """One moderation policy clause, citable by its stable id."""

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    text: str = Field(min_length=1)


# ---------------------------------------------------------------------------
# Minimal YAML subset parser (fallback when PyYAML is not installed).
# ---------------------------------------------------------------------------

_BLOCK_HEADER_RE = re.compile(r"^[|>][0-9]*[+-]?$")
_QUOTES = "\"'"


class YamlSubsetError(PolicyClauseError):
    """Raised when the fallback parser meets YAML it does not support."""


def _strip_comment(raw: str) -> str:
    """Drop a trailing ``# comment`` outside quoted scalars."""
    quote: Optional[str] = None
    for idx, char in enumerate(raw):
        if quote is not None:
            if char == quote:
                quote = None
            continue
        if char in _QUOTES:
            quote = char
            continue
        if char == "#" and (idx == 0 or raw[idx - 1] in " \t"):
            return raw[:idx].rstrip()
    return raw.rstrip()


def _split_key(line: str) -> tuple[str, bool, str]:
    """Split ``key: value`` at the first colon outside quotes."""
    quote: Optional[str] = None
    for idx, char in enumerate(line):
        if quote is not None:
            if char == quote:
                quote = None
            continue
        if char in _QUOTES:
            quote = char
            continue
        if char == ":" and (idx + 1 == len(line) or line[idx + 1] in " \t"):
            return line[:idx].strip(), True, line[idx + 1 :]
    return line.strip(), False, ""


def _unquote(raw: str) -> str:
    """Interpret a single-line scalar: double, single quoted or plain."""
    value = raw.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "0": "\0"}
        out: List[str] = []
        i = 0
        body = value[1:-1]
        while i < len(body):
            char = body[i]
            if char == "\\" and i + 1 < len(body):
                out.append(escapes.get(body[i + 1], body[i + 1]))
                i += 2
            else:
                out.append(char)
                i += 1
        return "".join(out)
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


class _YamlSubsetParser:
    """Parse the YAML subset used by policies.yaml.

    Supports top-level and nested mappings, lists of mappings (and of
    scalars), comments, and ``|``/``>`` block scalars with clip, strip
    and keep chomping. Anything richer raises :class:`YamlSubsetError`.
    """

    def __init__(self, text: str) -> None:
        self._lines = text.splitlines()
        self._i = 0

    # -- line helpers ------------------------------------------------------

    def peek(self) -> Optional[str]:
        """Return the next content line (comments/blanks skipped)."""
        while self._i < len(self._lines):
            line = _strip_comment(self._lines[self._i])
            if line.strip():
                return line
            self._i += 1
        return None

    @staticmethod
    def indent_of(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

    @staticmethod
    def is_item(line: str) -> bool:
        stripped = line.lstrip(" ")
        return stripped.startswith("- ") or stripped == "-"

    def _fail(self, message: str) -> YamlSubsetError:
        return YamlSubsetError(f"line {self._i + 1}: {message}")

    # -- structure ---------------------------------------------------------

    def parse_mapping(self, indent: int) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        while True:
            line = self.peek()
            if line is None or self.indent_of(line) < indent:
                return result
            if self.indent_of(line) > indent:
                raise self._fail(f"unexpected indentation: {line.strip()!r}")
            key, has_sep, rest = _split_key(line)
            if not key or not has_sep:
                raise self._fail(f"expected 'key: value', got {line.strip()!r}")
            self._i += 1
            rest = rest.strip()
            if not rest:
                result[key] = self._parse_child(indent)
            elif _BLOCK_HEADER_RE.match(rest):
                result[key] = self._parse_block_scalar(rest, indent)
            else:
                result[key] = _unquote(rest)

    def _parse_child(self, parent_indent: int) -> Any:
        child = self.peek()
        if child is None or self.indent_of(child) <= parent_indent:
            return None
        if self.is_item(child):
            return self.parse_list(self.indent_of(child))
        return self.parse_mapping(self.indent_of(child))

    def parse_list(self, indent: int) -> List[Any]:
        items: List[Any] = []
        while True:
            line = self.peek()
            if line is None or self.indent_of(line) != indent or not self.is_item(line):
                if line is not None and self.indent_of(line) > indent:
                    raise self._fail(f"unexpected indentation: {line.strip()!r}")
                return items
            content = line.lstrip(" ")[1:].lstrip(" ")
            if not content:
                # "- " alone: the item body follows on deeper lines.
                self._i += 1
                items.append(self._parse_child(indent))
                continue
            _key, has_sep, _rest = _split_key(content)
            if not has_sep:
                # Scalar list item.
                self._i += 1
                items.append(_unquote(content))
                continue
            # "- key: value": rewrite the dash as spaces so the item
            # parses as a mapping aligned after the dash.
            offset = len(line) - len(content)
            self._lines[self._i] = " " * offset + content
            items.append(self.parse_mapping(offset))

    def _parse_block_scalar(self, header: str, key_indent: int) -> str:
        style = header.strip()
        folded = style.startswith(">")
        if style.endswith("-"):
            chomp = "strip"
        elif style.endswith("+"):
            chomp = "keep"
        else:
            chomp = "clip"
        content: List[Optional[str]] = []
        content_indent: Optional[int] = None
        while self._i < len(self._lines):
            raw = self._lines[self._i]
            if not raw.strip():
                content.append(None)
                self._i += 1
                continue
            ind = self.indent_of(raw)
            if ind <= key_indent:
                break
            if content_indent is None:
                content_indent = ind
            if ind < content_indent:
                raise self._fail("inconsistent block scalar indentation")
            content.append(raw[content_indent:])
            self._i += 1
        trailing = 0
        while content and content[-1] is None:
            content.pop()
            trailing += 1
        text = ""
        pending_breaks = 0
        for piece in content:
            if piece is None:
                pending_breaks += 1
                continue
            if not text:
                text = piece
            elif pending_breaks:
                text += "\n" * pending_breaks + piece
            else:
                text += (" " if folded else "\n") + piece
            pending_breaks = 0
        if chomp == "strip":
            return text
        if chomp == "keep":
            return text + "\n" * (trailing + (1 if text else 0))
        return text + "\n" if text else ""


def parse_yaml_subset(text: str) -> Any:
    """Parse the YAML subset; raises :class:`YamlSubsetError` on richer input."""
    parser = _YamlSubsetParser(text)
    first = parser.peek()
    if first is None:
        return None
    if parser.is_item(first):
        data: Any = parser.parse_list(parser.indent_of(first))
    else:
        data = parser.parse_mapping(parser.indent_of(first))
    extra = parser.peek()
    if extra is not None:
        raise parser._fail(f"unexpected content after document: {extra.strip()!r}")
    return data


# ---------------------------------------------------------------------------
# Loading and validation.
# ---------------------------------------------------------------------------


def _parse_yaml_document(text: str) -> Any:
    """Prefer PyYAML when available, else the built-in subset parser."""
    try:
        import yaml  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        return parse_yaml_subset(text)
    return yaml.safe_load(text)


def bundled_policies_path() -> Path:
    """Path of the policies.yaml shipped with this module."""
    return Path(__file__).resolve().parent / DEFAULT_POLICIES_FILE


def policies_path() -> Path:
    """Resolve the policies file: env override first, then the bundled file."""
    for name in POLICIES_YAML_ENV_ALIASES:
        raw = os.getenv(name)
        if raw:
            return Path(raw)
    return bundled_policies_path()


def _coerce_scalar(value: Any) -> Any:
    """Let yaml numbers/booleans stand in for string clause fields."""
    if isinstance(value, (int, float, bool)) and not isinstance(value, bool):
        return str(value)
    return value


def load_clauses(path: Union[str, "os.PathLike[str]", None] = None) -> List[PolicyClause]:
    """Read, parse and validate the policy clause list from a yaml file.

    Raises :class:`PolicyClauseError` with a readable message when the
    file cannot be read, parsed or validated.
    """
    from pydantic import ValidationError

    resolved = Path(path) if path is not None else policies_path()
    try:
        text = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise PolicyClauseError(f"{resolved}: cannot read policies file ({exc})") from exc

    data = _parse_yaml_document(text)
    if isinstance(data, list):
        raw_clauses: Any = data
    elif isinstance(data, dict):
        raw_clauses = data.get("clauses")
        if raw_clauses is None:
            raise PolicyClauseError(f"{resolved}: missing 'clauses' list")
    else:
        raise PolicyClauseError(f"{resolved}: expected a clause list or a mapping with a 'clauses' list")
    if not isinstance(raw_clauses, list):
        raise PolicyClauseError(f"{resolved}: 'clauses' must be a list")

    clauses: List[PolicyClause] = []
    seen: set[str] = set()
    for position, item in enumerate(raw_clauses, start=1):
        if not isinstance(item, dict):
            raise PolicyClauseError(f"{resolved}: clause #{position} must be a mapping with id, title and text")
        payload = {key: _coerce_scalar(item.get(key)) for key in _CLAUSE_KEYS}
        try:
            clause = PolicyClause.model_validate(payload)
        except ValidationError as exc:
            raise PolicyClauseError(f"{resolved}: clause #{position} is invalid ({exc.errors()[0]['msg']})") from exc
        if clause.id in seen:
            raise PolicyClauseError(f"{resolved}: duplicate clause id {clause.id!r}")
        seen.add(clause.id)
        clauses.append(clause)
    return clauses


# Per-path cache keyed on the file's stat signature, so edits to the yaml
# are picked up without a process restart while repeated reads stay cheap.
_POLICY_CACHE: Dict[str, tuple[tuple[int, int], tuple[PolicyClause, ...]]] = {}


def clear_policy_cache() -> None:
    """Drop cached clause lists (useful after rewriting the yaml in tests)."""
    _POLICY_CACHE.clear()


def get_clauses(path: Union[str, "os.PathLike[str]", None] = None) -> List[PolicyClause]:
    """Return the policy clauses, cached per file until it changes."""
    resolved = Path(path) if path is not None else policies_path()
    key = str(resolved)
    try:
        stat = resolved.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        signature = (-1, -1)
    cached = _POLICY_CACHE.get(key)
    if cached is not None and cached[0] == signature:
        return list(cached[1])
    clauses = tuple(load_clauses(resolved))
    _POLICY_CACHE[key] = (signature, clauses)
    return list(clauses)


def get_clause(clause_id: str, path: Union[str, "os.PathLike[str]", None] = None) -> Optional[PolicyClause]:
    """Return the clause with the given id, or None when unknown."""
    for clause in get_clauses(path):
        if clause.id == clause_id:
            return clause
    return None
