"""The three Scholium Display cuts, defined once.

build_specimens.py drew them as A/B/C to choose between; on 2026-11-21 all
three were adopted as one family (Light / Regular / Bold). build_family.py
writes the family files from these same settings, so the specimen and the
shipped fonts cannot drift apart.
"""

# key, style, typeface.Design arguments, weight class, intended use
CUTS = [
    ("A", "Light", dict(stem=72, width=0.96, contrast=0.80), 300,
     "close-read pieces: cards, social posts"),
    ("B", "Regular", dict(stem=96, width=1.00, contrast=0.86), 400,
     "general headlines (the tool's default settings)"),
    ("C", "Bold", dict(stem=124, width=1.04, contrast=0.84), 700,
     "distance pieces: poster, pull-up banner"),
]
