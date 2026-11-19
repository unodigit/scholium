#!/usr/bin/env python3
"""Build the Scholium Handbook as one web page and one PDF.

The Markdown chapters in this folder are the source. This script joins them
into a single page and, with ``--pdf``, prints that page to a PDF.

Usage, from the repository root:

    uv run --no-project --with markdown python docs/handbook/build.py --pdf

Output goes to ``docs/handbook/dist/`` (``--out`` changes it; ignored by git):

- ``scholium-handbook.html``        the single web page
- ``scholium-handbook-print.html``  the same content laid out for A4
- ``scholium-handbook.pdf``         with ``--pdf``; printed by ``pdf.cjs`` with
  the repository's Playwright (``npm install`` at the root, plus
  ``npx playwright install chromium``) and network access for the web fonts and
  the diagram renderer. From a checkout without its own ``node_modules`` (a
  worktree), set ``NODE_PATH`` to another checkout's ``node_modules``.
"""

from __future__ import annotations

import argparse
import html
import pathlib
import re
import shutil
import subprocess
import sys

import markdown

HERE = pathlib.Path(__file__).resolve().parent

# Status icons as inline SVG, so they never depend on a font having the glyph.
_S = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
ICONS = {
    "open": f'<circle cx="7" cy="7" r="5" {_S}/>',
    "part": f'<circle cx="7" cy="7" r="5.2" {_S}/><path d="M7 7V1.8A5.2 5.2 0 0 1 12.2 7z" fill="currentColor"/>',
    "check": f'<path d="M3 7.4l2.6 2.6L11 4.4" {_S} stroke-width="1.9"/>',
    "warn": f'<path d="M7 2.2l5.2 9.4H1.8z" {_S}/>',
    "pen": f'<path d="M2.6 11.4l.6-2.7 6.2-6.2 2.1 2.1-6.2 6.2z" {_S}/>',
    "cross": f'<path d="M4 4l6 6M10 4l-6 6" {_S} stroke-width="1.9"/>',
    "spin": f'<path d="M12 7a5 5 0 1 1-1.6-3.7" {_S}/>',
    "ask": f'<circle cx="7" cy="7" r="5.2" {_S}/><path d="M5.6 5.7a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6 1" {_S}/>'
    '<circle cx="7" cy="10" r=".8" fill="currentColor"/>',
}

STATUSES = {
    "Preprint": ("neutral", "open"),
    "Under review": ("pending", "part"),
    "Reviewed": ("verified", "check"),
    "Contested": ("pending", "warn"),
    "Corrected": ("pending", "pen"),
    "Retracted": ("critical", "cross"),
}

BADGES = {
    "Verified": ("verified", "check"),
    "Signed · anchor pending": ("pending", "part"),
    "Checking…": ("neutral", "spin"),
    "Could not check": ("neutral", "ask"),
    "Verification failed": ("critical", "cross"),
}

MARK_SVG = (
    '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true">'
    '<rect width="32" height="32" rx="6" class="mark-tile"/>'
    '<path class="mark-cut" fill-rule="evenodd" d="M8 9h10v14H8V9zm2 3v2h6v-2h-6zm0 4v2h6v-2h-6zm0 4v2h4v-2h-4z"/>'
    '<path class="mark-cut" d="M20 7h4v18h-4v-2h2V9h-2V7z"/>'
    "</svg>"
)

MERMAID_SCRIPT = (
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js" '
    'integrity="sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I" '
    'crossorigin="anonymous"></script>\n'
    "<script>mermaid.initialize({startOnLoad: true, theme: 'neutral', "
    "fontFamily: 'Inter, system-ui, sans-serif', flowchart: {htmlLabels: true}});</script>"
)


def slug(text: str) -> str:
    """GitHub-style heading anchor, matching the links in the Markdown."""
    text = text.strip().lower()
    text = re.sub(r"[`*_]", "", text)
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def strip_tags(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment))


class Chapter:
    def __init__(self, num: int, title: str, body: str, sections: list[tuple[str, str]]):
        self.num = num
        self.title = title
        self.body = body
        self.sections = sections

    @property
    def anchor(self) -> str:
        return f"c{self.num}"


def chip(tone: str, icon: str, word: str) -> str:
    return (
        f'<span class="chip chip-{tone}"><svg class="chip-icon" viewBox="0 0 14 14" aria-hidden="true">'
        f"{ICONS[icon]}</svg>{word}</span>"
    )


def render_chapter(num: int, md_text: str, title_override: str | None = None) -> Chapter:
    body = markdown.markdown(md_text, extensions=["tables", "fenced_code", "sane_lists"])
    sections: list[tuple[str, str]] = []
    title = title_override or ""

    # Diagrams: hand Mermaid its own block.
    body = re.sub(
        r'<pre><code class="language-mermaid">(.*?)</code></pre>',
        r'<pre class="mermaid">\1</pre>',
        body,
        flags=re.S,
    )

    # Headings: shift down one level (the page has its own h1) and give each a
    # chapter-scoped id so anchors never collide across chapters.
    def heading(m: re.Match[str]) -> str:
        nonlocal title
        level, inner = int(m.group(1)), m.group(2)
        text = strip_tags(inner)
        if level == 1:
            match = re.match(r"(\d+)\.\s+(.*)", text)
            title = match.group(2) if match else text
            return (
                f'<h2 id="c{num}" class="chapter-title"><span class="chapter-num">'
                f"Chapter {num}</span>{html.escape(title)}</h2>"
            )
        anchor = f"c{num}-{slug(text)}"
        if level == 2:
            sections.append((anchor, text))
        return f'<h{level + 1} id="{anchor}">{inner}</h{level + 1}>'

    body = re.sub(r"<h([1-6])>(.*?)</h\1>", heading, body)

    # Links: chapter files become in-page anchors; links out of the handbook
    # folder (docs/deploy.md) become plain text.
    body = re.sub(r'<a href="\.\./[^"]*">(.*?)</a>', r"\1", body)

    def link(m: re.Match[str]) -> str:
        href = html.unescape(m.group(1))
        if re.match(r"[a-z]+:", href):
            return m.group(0)
        path, _, frag = href.partition("#")
        target = int(path[:2]) if path else num
        return f'href="#c{target}-{frag}"' if frag else f'href="#c{target}"'

    body = re.sub(r'href="([^"]+)"', link, body)

    # Call-outs become margin notes; the AI banner keeps its own look.
    def callout(m: re.Match[str]) -> str:
        inner = m.group(1)
        if "Advisory. Generated by AI agents" in inner:
            first, _, rest = inner.partition("</p>")
            banner = strip_tags(first).strip().strip('"“”')
            return (
                '<div class="ai-banner"><p class="ai-banner-text">'
                f'<span aria-hidden="true">◇</span> {html.escape(banner)}</p>{rest}</div>'
            )
        return f'<aside class="note">{inner}</aside>'

    body = re.sub(r"<blockquote>\s*(.*?)\s*</blockquote>", callout, body, flags=re.S)

    # Status words and verification states in tables: icon plus word, as in the app.
    words = "|".join(re.escape(w) for w in STATUSES)
    body = re.sub(
        rf"<td>(?:<strong>)?({words})(?:</strong>)?</td>",
        lambda m: f"<td>{chip(*STATUSES[m.group(1)], m.group(1))}</td>",
        body,
    )
    badges = "|".join(re.escape(w) for w in BADGES)
    body = re.sub(
        rf"<td><strong>({badges})</strong>(?: \([^)]*\))?</td>",
        lambda m: f"<td>{chip(*BADGES[m.group(1)], m.group(1))}</td>",
        body,
    )

    # Wide tables scroll inside their own box, never the page.
    body = body.replace("<table>", '<div class="table-wrap"><table>').replace("</table>", "</table></div>")

    return Chapter(num, title, body, sections)


def load_chapters() -> tuple[Chapter, list[Chapter]]:
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    readme = re.sub(r"^# .*\n", "", readme, count=1)
    readme = re.sub(r"^## Chapters\n.*?(?=^## )", "", readme, flags=re.S | re.M)
    intro = render_chapter(0, readme, title_override="Start here")
    intro.body = f'<h2 id="c0" class="chapter-title"><span class="chapter-num">Introduction</span>Start here</h2>\n{intro.body}'

    chapters = []
    for path in sorted(HERE.glob("[0-9][0-9]-*.md")):
        chapters.append(render_chapter(int(path.name[:2]), path.read_text(encoding="utf-8")))
    return intro, chapters


STYLE = r"""
/* Layout: a reading column with the handbook's notes in its right margin (the
   scholium), a contents rail on the left; one column on phones. */
:root {
  --bg: #FBFAF7; --surface: #FFFFFF; --ink: #1B1D22; --ink-2: #5A5F6B; --rule: #E4E1D9;
  --accent: #2F4BA0; --verified: #1F7A54; --pending: #9A6B00; --critical: #B3312B;
  --ai: #6B4BA8; --ai-wash: #F4F0FB; --margin-note: #FFF6D6; --code-bg: #F2F0EA;
  --serif: "Source Serif 4", "Source Serif Pro", Georgia, "Times New Roman", serif;
  --sans: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14151A; --surface: #1C1E25; --ink: #ECEBE6; --ink-2: #A3A7B2; --rule: #2C2F38;
    --accent: #8FA6F0; --verified: #5CC79A; --pending: #E0B14A; --critical: #F08A84;
    --ai: #B9A2F2; --ai-wash: #241F33; --margin-note: #3A3320; --code-bg: #22242C;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #14151A; --surface: #1C1E25; --ink: #ECEBE6; --ink-2: #A3A7B2; --rule: #2C2F38;
  --accent: #8FA6F0; --verified: #5CC79A; --pending: #E0B14A; --critical: #F08A84;
  --ai: #B9A2F2; --ai-wash: #241F33; --margin-note: #3A3320; --code-bg: #22242C;
  color-scheme: dark;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 400 15px/1.6 var(--sans);
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }

.masthead { max-width: 76rem; margin: 0 auto; padding-block: 48px 32px; border-bottom: 1px solid var(--rule); }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
.mark { width: 28px; height: 28px; flex: none; }
.mark-tile { fill: var(--accent); }
.mark-cut { fill: var(--bg); }
.wordmark { font: 600 24px/1 var(--serif); letter-spacing: -0.01em; }
.brand-sub { font: 500 12px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-2); padding-top: 4px; }
.masthead h1 { font: 600 clamp(32px, 5vw, 48px)/1.12 var(--serif); margin: 0 0 14px; text-wrap: balance; letter-spacing: -0.015em; }
.lede { font: 400 20px/1.5 var(--serif); color: var(--ink); margin: 0 0 14px; max-width: 40rem; }
.meta { font-size: 13px; color: var(--ink-2); margin: 0; }
.meta code { font-size: 12px; }

.layout { max-width: 76rem; margin: 0 auto; display: grid; grid-template-columns: 13.5rem minmax(0, 1fr); gap: 3rem; padding-block: 32px 96px; }
.toc { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 24px); align-self: start; max-height: calc(100vh - 48px); overflow-y: auto; font-size: 13.5px; }
.toc summary { font: 600 11.5px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-2); padding: 6px 0 12px; cursor: pointer; list-style: none; }
.toc summary::-webkit-details-marker { display: none; }
.toc ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.toc a { display: grid; grid-template-columns: 1.6rem 1fr; padding: 5px 8px; border-radius: 6px; color: var(--ink-2); text-decoration: none; line-height: 1.35; }
.toc a:hover { color: var(--ink); background: var(--code-bg); }
.toc a.active { color: var(--accent); background: var(--surface); box-shadow: inset 0 0 0 1px var(--rule); }
.toc .n { font: 500 12px/1.35 var(--mono); color: inherit; opacity: 0.75; padding-top: 1px; }

.book { min-width: 0; max-width: 44rem; }
.chapter { padding-top: 8px; margin-bottom: 72px; }
.chapter + .chapter { border-top: 1px solid var(--rule); padding-top: 48px; }
.chapter-title { font: 600 32px/1.2 var(--serif); margin: 0 0 20px; letter-spacing: -0.01em; text-wrap: balance; scroll-margin-top: 24px; }
.chapter-num { display: block; font: 600 11.5px/1 var(--sans); text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); margin-bottom: 12px; }
.book h3 { font: 600 22px/1.3 var(--serif); margin: 44px 0 12px; text-wrap: balance; scroll-margin-top: 24px; }
.book h4 { font: 600 16px/1.4 var(--sans); margin: 30px 0 8px; scroll-margin-top: 24px; }
.book p, .book li { font: 400 17px/1.7 var(--serif); }
.book p { margin: 0 0 14px; }
.book ul, .book ol { padding-left: 1.4rem; margin: 0 0 16px; }
.book li { margin-bottom: 6px; }
.book li > p { margin: 0; }
.book strong { font-weight: 600; }
.book code { font: 400 0.82em/1 var(--mono); background: var(--code-bg); padding: 0.18em 0.38em; border-radius: 4px; overflow-wrap: anywhere; }
.book pre:not(.mermaid) { background: var(--code-bg); padding: 14px 16px; border-radius: 8px; overflow-x: auto; font: 13px/1.6 var(--mono); }
.book pre code { background: none; padding: 0; font-size: inherit; }

.table-wrap { overflow-x: auto; margin: 6px 0 22px; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); }
table { border-collapse: collapse; width: 100%; font: 400 14px/1.5 var(--sans); }
th { text-align: left; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-2); background: var(--bg); }
th, td { padding: 9px 14px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td code { font-size: 12.5px; }
td:first-child { min-width: 7.5rem; }

.chip { display: inline-flex; align-items: center; gap: 6px; font: 500 13px/1 var(--sans); padding: 4px 9px 4px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.chip-icon { width: 13px; height: 13px; flex: none; }
.chip-neutral { color: var(--ink-2); }
.chip-pending { color: var(--pending); }
.chip-verified { color: var(--verified); }
.chip-critical { color: var(--critical); }

.note { background: var(--margin-note); border-radius: 8px; padding: 12px 14px; margin: 4px 0 18px; }
.note p { font: 400 14px/1.55 var(--sans); margin: 0 0 6px; }
.note p:last-child { margin-bottom: 0; }
.note code { font-size: 12px; background: transparent; padding: 0; }

.ai-banner { border: 1px solid var(--ai); border-left-width: 4px; background: var(--ai-wash); border-radius: 8px; padding: 14px 16px; margin: 4px 0 22px; }
.ai-banner p { font: 400 14.5px/1.55 var(--sans); margin: 0; }
.ai-banner .ai-banner-text { color: var(--ai); font-weight: 600; font-size: 15px; margin-bottom: 8px; }

pre.mermaid { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 20px 12px; margin: 8px 0 24px; overflow-x: auto; text-align: center; font: 13px/1.4 var(--sans); }
pre.mermaid svg { max-width: 100%; height: auto; }

.print-contents { display: none; }

/* Wide screens: notes move into the right margin, beside the text they gloss. */
@media (min-width: 1280px) {
  .book { margin-right: 17rem; }
  .note { float: right; clear: right; width: 15rem; margin-right: -17rem; margin-top: 6px; }
}
@media (max-width: 1023px) {
  .layout { grid-template-columns: minmax(0, 1fr); gap: 8px; padding-top: 16px; }
  .toc { position: static; max-height: none; border: 1px solid var(--rule); border-radius: 10px; padding: 6px 12px; background: var(--surface); }
  .toc summary { padding: 8px 0; }
  .toc ol { padding-bottom: 8px; }
}
@media (max-width: 640px) {
  .masthead { padding-block: 28px 20px; }
  .lede { font-size: 18px; }
  .chapter-title { font-size: 27px; }
  .book p, .book li { font-size: 16.5px; }
}
"""

PRINT_STYLE = r"""
@page { size: A4; margin: 18mm 17mm 20mm;
  @bottom-center { content: counter(page); font: 9pt Inter, sans-serif; color: #5A5F6B; } }
@page :first { @bottom-center { content: none; } }
@media print {
  body { padding: 0; font-size: 10.5pt; background: #FFFFFF; }
  .toc { display: none; }
  .layout { display: block; padding: 0; max-width: none; }
  .book { max-width: none; margin: 0; }
  .masthead { border: 0; padding: 70mm 0 0; min-height: 230mm; max-width: none; }
  .masthead h1 { font-size: 38pt; }
  .lede { font-size: 15pt; }
  .print-contents { display: block; break-before: page; }
  .print-contents h2 { font: 600 20pt/1.2 var(--serif); margin: 0 0 18px; }
  .print-contents ol { list-style: none; padding: 0; margin: 0; }
  .print-contents > ol > li { font: 600 11.5pt/1.4 var(--serif); margin: 0 0 9px; }
  .print-contents ol ol { font: 400 9.5pt/1.5 var(--sans); color: #5A5F6B; margin: 3px 0 0 1.6rem; columns: 2; column-gap: 18px; }
  .print-contents a { color: inherit; text-decoration: none; }
  .chapter { break-before: page; border: 0 !important; padding-top: 0 !important; margin: 0; }
  .chapter-title { font-size: 24pt; margin-bottom: 14px; }
  .book h3 { font-size: 15pt; margin-top: 22px; break-after: avoid; }
  .book h4 { font-size: 11.5pt; margin-top: 16px; break-after: avoid; }
  .book p, .book li { font-size: 10.5pt; line-height: 1.55; orphans: 3; widows: 3; }
  .book a { color: inherit; text-decoration: none; }
  table { font-size: 9pt; }
  th, td { padding: 6px 9px; }
  tr, .note, .ai-banner, pre { break-inside: avoid; }
  .table-wrap { overflow: visible; }
  .note { float: none; width: auto; margin: 6px 0 14px; }
  .note p { font-size: 9.5pt; }
  pre.mermaid { break-inside: avoid; padding: 12px; }
  pre.mermaid svg { max-height: 150mm; width: auto; }
}
"""

SCROLL_SPY = r"""
<script>
(() => {
  const links = new Map();
  document.querySelectorAll('.toc a').forEach((a) => links.set(a.getAttribute('href').slice(1), a));
  const narrow = window.matchMedia('(max-width: 1023px)');
  const details = document.querySelector('.toc details');
  const sync = () => { if (details) details.open = !narrow.matches; };
  sync();
  narrow.addEventListener('change', sync);
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((a) => a.classList.remove('active'));
      const a = links.get(e.target.id);
      if (a) a.classList.add('active');
    });
  }, { rootMargin: '0px 0px -75% 0px' });
  document.querySelectorAll('.chapter-title').forEach((h) => io.observe(h));
})();
</script>
"""

FONTS = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600'
    "&family=JetBrains+Mono:wght@400;500&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400"
    '&display=swap">'
)


def build_body(intro: Chapter, chapters: list[Chapter]) -> str:
    everything = [intro, *chapters]
    toc_items = "\n".join(
        f'<li><a href="#{c.anchor}"><span class="n">{c.num if c.num else "·"}</span>'
        f"<span>{html.escape(c.title)}</span></a></li>"
        for c in everything
    )
    print_items = "\n".join(
        f'<li><a href="#{c.anchor}">{f"{c.num}. " if c.num else ""}{html.escape(c.title)}</a>'
        + (
            "<ol>" + "".join(f'<li><a href="#{a}">{html.escape(t)}</a></li>' for a, t in c.sections) + "</ol>"
            if c.sections
            else ""
        )
        + "</li>"
        for c in everything
    )
    sections = "\n".join(f'<section class="chapter" aria-labelledby="{c.anchor}">\n{c.body}\n</section>' for c in everything)
    return f"""
<header class="masthead">
  <div class="brand">{MARK_SVG}<span class="wordmark">scholium</span><span class="brand-sub">Handbook</span></div>
  <h1>The Scholium Handbook</h1>
  <p class="lede">How Scholium works and how to use it, for readers, authors, reviewers and moderators.</p>
  <p class="meta">First release (Phase 1, community pilot) · Checked against the application code, November 2026</p>
</header>
<nav class="print-contents" aria-label="Contents (print)"><h2>Contents</h2><ol>{print_items}</ol></nav>
<div class="layout">
  <nav class="toc" aria-label="Contents"><details open><summary>Contents</summary><ol>
{toc_items}
  </ol></details></nav>
  <main class="book">
{sections}
  </main>
</div>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=pathlib.Path, default=HERE / "dist")
    parser.add_argument("--pdf", action="store_true", help="also print the handbook to PDF")
    args = parser.parse_args()
    out: pathlib.Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    intro, chapters = load_chapters()
    body = build_body(intro, chapters)
    head = (
        "<title>Scholium Handbook</title>\n"
        '<meta name="claude:viewport-fit-sides" content="cover">\n'
        '<meta name="description" content="How Scholium works and how to use it.">\n'
        f"{FONTS}\n<style>{STYLE}</style>\n"
    )

    # The web page: a fragment (the artifact host supplies the document shell
    # and renders the Mermaid blocks itself).
    web = out / "scholium-handbook.html"
    web.write_text(head + body + SCROLL_SPY, encoding="utf-8")

    # The print page: a full document, light theme, Mermaid rendered in-page.
    printable = out / "scholium-handbook-print.html"
    printable.write_text(
        '<!doctype html>\n<html lang="en" data-theme="light">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"{head}<style>{PRINT_STYLE}</style>\n</head>\n<body>\n{body}\n{MERMAID_SCRIPT}\n</body>\n</html>\n",
        encoding="utf-8",
    )
    print(f"wrote {web}\nwrote {printable}")

    if args.pdf:
        node = shutil.which("node")
        if not node:
            print("--pdf needs Node.js and the repository's Playwright.", file=sys.stderr)
            return 2
        pdf = out / "scholium-handbook.pdf"
        subprocess.run([node, str(HERE / "pdf.cjs"), str(printable), str(pdf)], check=True, timeout=180)
        print(f"wrote {pdf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
