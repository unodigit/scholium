"""Read a PNG the way a viewer would, with nothing but the standard library.

The share cards and the e-mail lockup are images; a test that only checks
``Content-Type: image/png`` cannot tell the outlined wordmark from the serif text
it replaced.  :func:`decode_png` gives the pixels (8-bit, non-interlaced, RGB or
RGBA: what ``next/og`` and the brand renders are) and :func:`ink_box` finds where
a colour was drawn, so a test can measure the drawing instead of trusting it.

Pillow is not an API dependency and these tests add none.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass
from typing import Optional

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png_size(data: bytes) -> tuple[int, int]:
    """``(width, height)`` from the IHDR chunk; fails if ``data`` is not a PNG."""
    assert data[:8] == PNG_SIGNATURE, f"not a PNG: {data[:16]!r}"
    assert data[12:16] == b"IHDR", "the first chunk of a PNG is IHDR"
    width, height = struct.unpack(">II", data[16:24])
    return width, height


@dataclass
class Image:
    width: int
    height: int
    channels: int
    #: One ``bytes`` per row, ``channels`` bytes per pixel.
    rows: list[bytes]

    def pixel(self, x: int, y: int) -> tuple[int, ...]:
        row = self.rows[y]
        return tuple(row[x * self.channels : (x + 1) * self.channels])


def decode_png(data: bytes) -> Image:
    width, height = png_size(data)
    depth, color_type, _compression, _filter, interlace = struct.unpack(">BBBBB", data[24:29])
    assert depth == 8 and color_type in (2, 6) and interlace == 0, (
        f"only 8-bit RGB/RGBA PNGs without interlacing are decoded here "
        f"(depth {depth}, colour type {color_type}, interlace {interlace})"
    )
    channels = 3 if color_type == 2 else 4

    compressed = bytearray()
    offset = 8
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        kind = data[offset + 4 : offset + 8]
        if kind == b"IDAT":
            compressed += data[offset + 8 : offset + 8 + length]
        offset += 12 + length
    raw = zlib.decompress(bytes(compressed))

    stride = width * channels
    assert len(raw) == height * (stride + 1), "the pixel data does not match the header"
    rows: list[bytes] = []
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1 : start + 1 + stride])
        if kind == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif kind == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind == 4:  # Paeth
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = previous[i]
                c = previous[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + predictor) & 0xFF
        else:
            assert kind == 0, f"unknown PNG filter {kind}"
        rows.append(bytes(line))
        previous = line
    return Image(width, height, channels, rows)


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def ink_box(
    image: Image,
    colour: str,
    *,
    tolerance: int = 24,
    region: Optional[tuple[int, int, int, int]] = None,
) -> Optional[tuple[int, int, int, int]]:
    """``(left, top, right, bottom)`` (right and bottom exclusive) of the pixels within ``tolerance`` of ``colour``.

    ``region`` limits the search to ``(left, top, right, bottom)``.  ``None`` when nothing was drawn in that colour.
    """
    red, green, blue = hex_rgb(colour)
    left, top, right, bottom = region or (0, 0, image.width, image.height)
    found = [image.width, image.height, -1, -1]
    step = image.channels
    for y in range(max(top, 0), min(bottom, image.height)):
        row = image.rows[y]
        for x in range(max(left, 0), min(right, image.width)):
            i = x * step
            if abs(row[i] - red) <= tolerance and abs(row[i + 1] - green) <= tolerance and abs(row[i + 2] - blue) <= tolerance:
                if step == 4 and row[i + 3] < 200:
                    continue
                if x < found[0]:
                    found[0] = x
                if x > found[2]:
                    found[2] = x
                if y < found[1]:
                    found[1] = y
                found[3] = y
    if found[2] < 0:
        return None
    return found[0], found[1], found[2] + 1, found[3] + 1


def ink_overlap(
    first: Image,
    first_box: tuple[int, int, int, int],
    second: Image,
    second_box: tuple[int, int, int, int],
    colour: str,
    *,
    tolerance: int = 150,
) -> float:
    """Intersection over union of the ``colour`` drawn inside two boxes, after scaling one onto the other.

    The two drawings may be at different sizes (a share card and the brand's reference render);
    the coarser one is sampled on the finer one's grid.  1.0 is the same shapes, a different
    typeface scores well below 0.5.  ``tolerance`` is the summed distance of the three channels
    from ``colour`` that still counts as ink, wide enough to take anti-aliased edges in.
    """
    if (second_box[2] - second_box[0]) < (first_box[2] - first_box[0]):
        first, first_box, second, second_box = second, second_box, first, first_box
    # ``second`` is now the finer drawing: walk its pixels, look up the matching ones in ``first``.
    target = hex_rgb(colour)

    def is_ink(image: Image, x: int, y: int) -> bool:
        i = x * image.channels
        row = image.rows[y]
        return sum(abs(row[i + k] - target[k]) for k in range(3)) <= tolerance

    width, height = second_box[2] - second_box[0], second_box[3] - second_box[1]
    scale_x = (first_box[2] - first_box[0]) / width
    scale_y = (first_box[3] - first_box[1]) / height
    inside = outside = 0
    for y in range(height):
        for x in range(width):
            a = is_ink(second, second_box[0] + x, second_box[1] + y)
            b = is_ink(first, first_box[0] + int(x * scale_x), first_box[1] + int(y * scale_y))
            inside += a and b
            outside += a or b
    return inside / outside if outside else 0.0
