"""Detecting hidden text in PDFs (plugin: sanitizer).

A PDF can carry text that a reader never sees but a machine extracting its
text layer will: white (or near-white) glyphs on a white page, glyphs drawn
at an unreadably small size, text rendered with the *invisible* render mode,
or transparent text.  It can also carry ordinary visible text that is aimed
at whatever language model later reads the document -- "ignore previous
instructions", a fake "system prompt", and so on.  This module finds both
kinds and reports them as ``hidden_text`` findings::

    from app.modules import sanitizer

    hits = sanitizer.analyze_hidden_text(pdf_bytes)   # tuple[HiddenTextHit]
    sanitizer.hidden_text_detail(hits)                # one row's detail

    result = sanitizer.scan_pdf_bytes(pdf_bytes)      # the usual scan entry
    result.finding("hidden_text")                     # a Finding, or None

The scan is best-effort and never raises: a PDF whose text layer pypdf
cannot read simply yields no hits, and the structural scan in :mod:`.pdf`
records ``pdf_unreadable`` for it.  Nothing is executed and no text is
altered; the finding's ``detail`` names *why* and quotes a short snippet of
the text so a moderator (and the AI pre-review) can see what was hidden.

Detection details
-----------------

Text geometry comes from pypdf's ``visitor_text`` callback: the effective
font size is the ``Tf`` size scaled by the text and current transformation
matrices (PDFs often draw at ``Tf 1`` with the real size in the matrices).
Fill colour and text render mode are tracked from the content stream's
graphics operators via ``visitor_operand_before``, including ``q``/``Q``
save/restore, the ``g``/``rg``/``k``/``cs``/``sc``/``scn`` fill colour
operators, ``Tr`` (render mode) and ``gs`` (``/ca`` fill alpha).

A text piece is hidden when

* its fill colour is white or near-white (on the usual white page),
* its fill alpha is effectively zero, or
* it is drawn with render mode 3 or 7 (invisible / clip-only), or
* its effective font size is below :data:`TINY_FONT_SIZE` points.

Separately, the page's extracted text is matched against
:data:`INSTRUCTION_PATTERNS` -- phrases that try to steer a downstream
model.  Instruction-like text is reported even when it is perfectly
visible: the hazard is the prompt injection, not the visibility.
"""

from __future__ import annotations

import io
import math
import re
from collections.abc import Buffer, Sequence
from dataclasses import dataclass
from typing import Any, BinaryIO, Optional, Union

from pypdf import PdfReader

__all__ = [
    "CHECK_HIDDEN_TEXT",
    "INSTRUCTION_PATTERNS",
    "NEAR_TRANSPARENT",
    "NEAR_WHITE",
    "TINY_FONT_SIZE",
    "HiddenTextHit",
    "analyze_hidden_text",
    "analyze_hidden_text_reader",
    "detect_hidden_text",
    "hidden_text_detail",
]

#: The ``check_name`` written to ``scan_reports`` for hidden text.
CHECK_HIDDEN_TEXT = "hidden_text"

#: Text drawn smaller than this many points is treated as hidden.
#: The spec says "text under 2pt", so the comparison is strict.
TINY_FONT_SIZE = 2.0
#: Fill brightness (0..1) at or above which text reads as white.
NEAR_WHITE = 0.85
#: Fill alpha at or below which text is effectively invisible.
NEAR_TRANSPARENT = 0.10

#: Which hazard a hit represents; also the words used in ``detail``.
KIND_WHITE = "white text"
KIND_TRANSPARENT = "transparent text"
KIND_INVISIBLE = "invisible text"
KIND_TINY = "tiny text"
KIND_INSTRUCTION = "instruction-like text"

#: Longest snippet of the offending text quoted in a detail string.
_MAX_SNIPPET = 80
#: How many individual places are listed before the detail summarises.
_MAX_LOCATIONS = 10

#: Phrases aimed at a downstream model.  Matched case-insensitively against
#: the page's whitespace-normalised text.  The list is intentionally narrow
#: -- bare words like "instruction" appear in every paper -- and each entry
#: is a recognisable prompt-injection construction.
INSTRUCTION_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        # ignore / disregard previous instructions
        r"\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+|your\s+)*"
        r"(?:of\s+)?(?:the\s+|your\s+)?"
        r"(?:previous|prior|above|preceding|earlier|foregoing)\s+"
        r"(?:instruction|direction|prompt|command|rule|constraint)s?\b",
        # ... the instructions above
        r"\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)*"
        r"(?:instruction|direction|prompt|command|rule|constraint)s?\s+"
        r"(?:above|before|previously)\b",
        # override your system prompt / bypass the safety rules
        r"\b(?:override|bypass|ignore|disregard)\s+"
        r"(?:all\s+|any\s+|the\s+|your\s+)*"
        r"(?:system\s+|safety\s+|developer\s+|hidden\s+)?"
        r"(?:instruction|guideline|restriction|rule|prompt|constraint)s?\b",
        # you are now an AI assistant / language model
        r"\byou\s+are\s+(?:now\s+)?(?:an?\s+|the\s+)?"
        r"(?:ai|a\.i\.|assistant|chatbot|language\s+model|helpful\s+assistant|dan)\b",
        # reveal / print your system prompt
        r"\b(?:reveal|print|repeat|output|show|tell\s+me)\s+(?:me\s+)?"
        r"(?:your\s+|the\s+)?(?:system\s+|hidden\s+|secret\s+|initial\s+)?"
        r"(?:prompt|instructions?)\b",
        # new instructions: ...
        r"\bnew\s+(?:system\s+)?instructions?\s*:",
        r"\bsystem\s+prompt\b",
        # keep this hidden from the reader
        r"\b(?:do\s+not|don't|never)\s+"
        r"(?:tell|inform|reveal\s+(?:this\s+)?to)\s+(?:the\s+)?"
        r"(?:user|human|reader|reviewer|author)\b",
        r"\bprompt\s+injection\b",
        # chat-template markers and jailbreak phrasing
        r"\bas\s+an?\s+(?:ai|artificial\s+intelligence)\s+(?:language\s+)?model\b",
        r"<\|im_start\|>|\[/?inst\]|<<\s*/?\s*sys\s*>>|"
        r"###\s*(?:system|instruction)\s*:",
    )
)


@dataclass(frozen=True)
class HiddenTextHit:
    """One reason a piece of a PDF's text is hidden or hostile."""

    #: One of the ``KIND_*`` labels.
    kind: str
    #: 1-based page number the text was found on.
    page: int
    #: A short, whitespace-collapsed excerpt of the offending text.
    snippet: str = ""
    #: Effective font size in points, when known (for :data:`KIND_TINY`).
    size: Optional[float] = None

    def describe(self) -> str:
        """A human-readable location line for a scan report's ``detail``."""
        where = f"page {self.page}"
        if self.kind == KIND_TINY:
            if self.size is not None:
                where = f"{KIND_TINY} ({self.size:.2g}pt) at {where}"
            else:  # pragma: no cover - a tiny hit always carries its size
                where = f"{KIND_TINY} at {where}"
        else:
            where = f"{self.kind} at {where}"
        if self.snippet:
            return f"{where}: {_quote(self.snippet)}"
        return where


def analyze_hidden_text(
    pdf: Union[Buffer, BinaryIO],
) -> tuple[HiddenTextHit, ...]:
    """The hidden-text hits in ``pdf``, in page order.

    Args:
        pdf: the PDF's bytes, or a binary file object holding them.

    Returns:
        The hits (empty for a clean, readable PDF).  Bad or unreadable input
        yields ``()`` rather than raising: the structural scan owns the
        ``pdf_unreadable`` verdict.
    """
    stream = io.BytesIO(bytes(pdf)) if isinstance(pdf, Buffer) else pdf
    try:
        reader = PdfReader(stream, strict=False)
        if reader.is_encrypted:
            try:
                if not reader.decrypt(""):
                    return ()
            except Exception:  # noqa: BLE001 - undecryptable means no text
                return ()
        return analyze_hidden_text_reader(reader)
    except Exception:  # noqa: BLE001 - pypdf raises many unrelated types
        return ()


def detect_hidden_text(
    pdf: Union[Buffer, BinaryIO],
) -> tuple[HiddenTextHit, ...]:
    """Alias for :func:`analyze_hidden_text`."""
    return analyze_hidden_text(pdf)


def analyze_hidden_text_reader(reader: PdfReader) -> tuple[HiddenTextHit, ...]:
    """The hidden-text hits in an already-open :class:`PdfReader`."""
    hits: list[HiddenTextHit] = []
    try:
        pages = list(reader.pages)
    except Exception:  # noqa: BLE001 - damaged page tree: nothing to scan
        return ()
    for number, page in enumerate(pages, start=1):
        try:
            hits.extend(_PageCollector(page).collect(number))
        except Exception:  # noqa: BLE001 - one bad page must not stop the scan
            continue
    return tuple(hits)


def hidden_text_detail(hits: Sequence[HiddenTextHit]) -> str:
    """The ``detail`` string for one ``hidden_text`` report row."""
    if not hits:
        return "PDF contains no hidden text"
    shown = [hit.describe() for hit in hits[:_MAX_LOCATIONS]]
    if len(hits) > _MAX_LOCATIONS:
        shown.append(f"and {len(hits) - _MAX_LOCATIONS} more")
    joined = "; ".join(shown)
    if len(hits) == 1:
        return f"PDF contains hidden text: {joined}"
    return f"PDF contains hidden text in {len(hits)} places: {joined}"


class _PageCollector:
    """Extracts one page's text pieces and classifies them as it goes."""

    def __init__(self, page: Any) -> None:
        self._page = page
        #: ``(kind, components)`` of the current non-stroking colour.
        self._fill: tuple[str, tuple[float, ...]] = ("gray", (0.0,))
        #: ``/ca`` fill alpha from the graphics state.
        self._alpha = 1.0
        #: Text render mode (``Tr``); 3 and 7 draw no visible glyphs.
        self._render_mode = 0
        #: ``q``/``Q`` save stack for the state above.
        self._stack: list[tuple[tuple[str, tuple[float, ...]], float, int]] = []
        #: ``(text, effective size, fill, alpha, render mode)`` per piece.
        self._pieces: list[
            tuple[str, Optional[float], tuple[str, tuple[float, ...]], float, int]
        ] = []

    # -- pypdf visitor callbacks ------------------------------------------- #

    def _operand_before(
        self, operator: Any, operands: Sequence[Any], cm: Any, tm: Any
    ) -> None:
        op = _op_name(operator)
        if op == "q":
            self._stack.append((self._fill, self._alpha, self._render_mode))
            return
        if op == "Q":
            if self._stack:
                self._fill, self._alpha, self._render_mode = self._stack.pop()
            return
        if op == "g" and len(operands) >= 1:
            values = _floats(operands[:1])
            if values is not None:
                self._fill = ("gray", values)
        elif op == "rg" and len(operands) >= 3:
            values = _floats(operands[:3])
            if values is not None:
                self._fill = ("rgb", values)
        elif op == "k" and len(operands) >= 4:
            values = _floats(operands[:4])
            if values is not None:
                self._fill = ("cmyk", values)
        elif op == "cs" and operands:
            space = _name(operands[0])
            if space:
                self._fill = (space, ())
        elif op in ("sc", "scn"):
            values = _floats(operands)
            if values is not None:
                space = self._fill[0]
                if len(values) == 4:
                    space = "cmyk"
                elif len(values) == 3:
                    space = "rgb"
                elif len(values) == 1:
                    space = "gray"
                self._fill = (space, values)
        elif op == "Tr" and operands:
            mode = _number(operands[0])
            if mode is not None:
                self._render_mode = int(mode)
        elif op == "gs" and operands:
            alpha = self._extgstate_alpha(operands[0])
            if alpha is not None:
                self._alpha = alpha

    def _text(
        self, text: str, cm: Any, tm: Any, font: Any, size: Any
    ) -> None:
        if not text:
            return
        self._pieces.append(
            (
                text,
                _effective_size(cm, tm, size),
                self._fill,
                self._alpha,
                self._render_mode,
            )
        )

    # -- classification ---------------------------------------------------- #

    def collect(self, page_number: int) -> list[HiddenTextHit]:
        plain = self._page.extract_text(
            visitor_operand_before=self._operand_before,
            visitor_text=self._text,
        )
        hits: list[HiddenTextHit] = []
        seen: set[tuple[str, str]] = set()

        for text, size, fill, alpha, render_mode in self._pieces:
            snippet = _snippet(text)
            if not snippet:
                continue
            if _is_near_white(fill):
                _append(hits, seen, KIND_WHITE, page_number, snippet)
            if render_mode in (3, 7):
                _append(hits, seen, KIND_INVISIBLE, page_number, snippet)
            elif alpha <= NEAR_TRANSPARENT:
                _append(hits, seen, KIND_TRANSPARENT, page_number, snippet)
            if size is not None and size < TINY_FONT_SIZE:
                _append(hits, seen, KIND_TINY, page_number, snippet, size=size)

        # Match both pypdf's own extraction (which has the page's line breaks
        # and spacing) and the raw pieces joined without separators (which
        # keeps a phrase split across a ``TJ`` array or two ``Tj`` operators
        # together).  A phrase found either way is a hit.
        texts = [plain] if plain else []
        joined = "".join(text for text, *_ in self._pieces)
        if joined:
            texts.append(joined)
        for candidate in texts:
            for match in _instruction_matches(candidate):
                _append(
                    hits, seen, KIND_INSTRUCTION, page_number, _snippet(match)
                )
        return hits

    def _extgstate_alpha(self, name: Any) -> Optional[float]:
        """The ``/ca`` (fill alpha) of an ``/ExtGState`` referenced by ``gs``."""
        key = _name(name)
        if not key:
            return None
        try:
            resources = self._page.get("/Resources")
            if resources is None:
                return None
            resources = resources.get_object()
            states = resources.get("/ExtGState")
            if states is None:
                return None
            states = states.get_object()
            state = states.get(key)
            if state is None:
                return None
            return _number(state.get_object().get("/ca"))
        except Exception:  # noqa: BLE001 - a malformed state is not a hazard
            return None


def _append(
    hits: list[HiddenTextHit],
    seen: set[tuple[str, str]],
    kind: str,
    page: int,
    snippet: str,
    *,
    size: Optional[float] = None,
) -> None:
    marker = (kind, snippet)
    if marker in seen:
        return
    seen.add(marker)
    hits.append(HiddenTextHit(kind=kind, page=page, snippet=snippet, size=size))


def _instruction_matches(text: str) -> list[str]:
    """Distinct instruction-like phrases in ``text``, in order of appearance."""
    normalised = re.sub(r"\s+", " ", text)
    matches: list[str] = []
    seen: set[str] = set()
    for pattern in INSTRUCTION_PATTERNS:
        for match in pattern.finditer(normalised):
            phrase = match.group(0).strip()
            key = phrase.lower()
            if phrase and key not in seen:
                seen.add(key)
                matches.append(phrase)
    return matches


# -- text geometry --------------------------------------------------------- #


def _effective_size(cm: Any, tm: Any, font_size: Any) -> Optional[float]:
    """The drawn font size: ``Tf`` size scaled by the text/current matrices.

    PDFs commonly draw at ``Tf 1`` and put the real size in the matrices, so
    the vertical scale of the combined matrix is applied to the font size.
    ``None`` means the size could not be determined.
    """
    try:
        _a1, _b1, c1, d1, _e1, _f1 = (float(value) for value in tm[:6])
        a2, b2, _c2, _d2, _e2, _f2 = (float(value) for value in cm[:6])
        scale = math.hypot(c1 * a2 + d1 * _c2, c1 * b2 + d1 * _d2)
        size = abs(float(font_size)) * scale
    except (TypeError, ValueError, IndexError):
        return None
    if not math.isfinite(size):
        return None
    return size


# -- colour helpers -------------------------------------------------------- #


def _is_near_white(fill: tuple[str, tuple[float, ...]]) -> bool:
    """Whether a fill colour is white or near-white (RGB, gray or CMYK)."""
    space, components = fill
    if not components:
        return False
    if len(components) == 1:
        return components[0] >= NEAR_WHITE
    if len(components) == 3:
        return all(component >= NEAR_WHITE for component in components)
    if len(components) == 4:
        # CMYK: no ink of any kind is white.
        return all(component <= 1.0 - NEAR_WHITE for component in components)
    return False


def _op_name(operator: Any) -> str:
    if isinstance(operator, bytes):
        return operator.decode("latin-1", "replace")
    return str(operator)


def _name(value: Any) -> Optional[str]:
    text = _op_name(value)
    return text if text.startswith("/") else None


def _number(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _floats(values: Sequence[Any]) -> Optional[tuple[float, ...]]:
    numbers = []
    for value in values:
        number = _number(value)
        if number is None:
            return None
        numbers.append(number)
    return tuple(numbers)


# -- text helpers ---------------------------------------------------------- #


def _snippet(text: str) -> str:
    """Whitespace-collapsed, length-bounded excerpt of ``text``."""
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) <= _MAX_SNIPPET:
        return collapsed
    return collapsed[: _MAX_SNIPPET - 3] + "..."


def _quote(text: str) -> str:
    return f'"{text}"'
