/**
 * The Markdown a review report may use (docs/design.md §5.5: "Markdown is
 * allowed").
 *
 * A report is written by a reviewer and read by everyone, so the form's
 * promise is kept with a deliberately small, safe subset instead of a general
 * renderer:
 *
 * - paragraphs (a blank line); a single line break inside one is kept
 * - `*emphasis*` / `_emphasis_` and `**strong**` / `__strong__`
 * - `-`, `*`, `+` bulleted and `1.` numbered lists (one level)
 * - `[text](url)` links, for `http:`, `https:` and `mailto:` addresses only
 * - `` `inline code` `` and fenced code blocks
 *
 * Everything else — headings, quotes, tables, images, and above all raw HTML —
 * is not markup here and stays as the text the reviewer typed. The parser
 * returns a small tree of plain data; {@link ReportMarkdown} turns that into
 * React elements, so there is no point at which a string is parsed as HTML.
 *
 * Pure functions, no React, never throws.
 */

/** Inline content. */
export type MdInline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "br" }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "em"; readonly children: readonly MdInline[] }
  | { readonly type: "strong"; readonly children: readonly MdInline[] }
  | { readonly type: "link"; readonly href: string; readonly children: readonly MdInline[] };

/** Block content. */
export type MdBlock =
  | { readonly type: "paragraph"; readonly children: readonly MdInline[] }
  | { readonly type: "code"; readonly text: string }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      /** The number an ordered list starts at. */
      readonly start: number;
      readonly items: readonly (readonly MdInline[])[];
    };

/** Addresses a report may link to. Anything else is shown as typed. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s<>"'`\\]+$/i;

/**
 * Whether `href` may become a link: an `http(s)` or `mailto` address with no
 * whitespace, quote or angle bracket in it, that the URL parser also reads as
 * one of those (so a control character cannot hide another scheme).
 */
export function isSafeHref(href: string): boolean {
  if (!SAFE_HREF.test(href)) return false;
  try {
    const { protocol } = new URL(href);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

const ESCAPABLE = "\\`*_[]()#+-.!<>";

const isSpace = (char: string | undefined): boolean =>
  char === undefined || /\s/.test(char);
const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Index of the first `delimiter` at or after `from` that may close emphasis, or -1. */
function findClose(source: string, delimiter: string, from: number): number {
  const first = delimiter[0];
  let index = source.indexOf(delimiter, from);
  while (index !== -1) {
    // A run of the same character closes at its end: `***a***` is strong
    // around emphasis, not emphasis around a stray star.
    let end = index + delimiter.length;
    while (source[end] === first) end += 1;
    const close = end - delimiter.length;
    const before = source[close - 1];
    const after = source[close + delimiter.length];
    const flanked = close > from && !isSpace(before);
    // `snake_case_name` is a name, not emphasis: underscores need a boundary.
    const bounded = first !== "_" || !isWordChar(after);
    if (flanked && bounded) return close;
    index = source.indexOf(delimiter, end);
  }
  return -1;
}

/** Parse the inline Markdown of one run of text. */
export function parseInline(source: string): MdInline[] {
  const out: MdInline[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") out.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i];

    if (char === "\\" && i + 1 < source.length && ESCAPABLE.includes(source[i + 1])) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (char === "\n") {
      flush();
      out.push({ type: "br" });
      i += 1;
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (source[i + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = source.indexOf(fence, i + run);
      if (close !== -1 && source[close + run] !== "`") {
        flush();
        const raw = source.slice(i + run, close).replace(/\n/g, " ");
        // One space of padding is how a span may start or end with a backtick.
        const code = /^ .*[^ ].* $/.test(raw) ? raw.slice(1, -1) : raw;
        out.push({ type: "code", text: code });
        i = close + run;
        continue;
      }
      text += fence;
      i += run;
      continue;
    }

    if (char === "[") {
      const link = /^\[([^\]\n]+)\]\(([^()\s]+)(?:\s+"[^"\n]*")?\)/.exec(source.slice(i));
      if (link !== null && isSafeHref(link[2])) {
        flush();
        out.push({
          type: "link",
          href: link[2],
          children: parseInline(link[1]).filter((node) => node.type !== "link"),
        });
        i += link[0].length;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const delimiter = source.startsWith(char + char, i) ? char + char : char;
      const opens =
        !isSpace(source[i + delimiter.length]) &&
        // `snake_case`: an underscore inside a word is not an opener.
        (char !== "_" || !isWordChar(source[i - 1]));
      if (opens) {
        const close = findClose(source, delimiter, i + delimiter.length);
        if (close !== -1) {
          flush();
          const children = parseInline(source.slice(i + delimiter.length, close));
          out.push({ type: delimiter.length === 2 ? "strong" : "em", children });
          i = close + delimiter.length;
          continue;
        }
      }
      // Not markup: the whole run is text, so `**` is not retried as `*`.
      text += delimiter;
      i += delimiter.length;
      continue;
    }

    text += char;
    i += 1;
  }

  flush();
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/;
const BULLET = /^ {0,3}([-*+])\s+(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;

/** Parse a report into blocks. */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];

  let paragraph: string[] = [];
  const endParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    }
    paragraph = [];
  };

  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const endList = (): void => {
    if (list !== null) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map((item) => parseInline(item)),
      });
    }
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = FENCE.exec(line);
    if (fence !== null) {
      endParagraph();
      endList();
      const marker = fence[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      endParagraph();
      endList();
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    // A bullet may interrupt a paragraph; a number only when it starts at 1, so
    // a sentence that wraps before "2024." is not turned into a list.
    const starts =
      bullet !== null ||
      (numbered !== null && (paragraph.length === 0 || Number(numbered[1]) === 1));
    if (starts) {
      endParagraph();
      const match = (bullet ?? numbered) as RegExpExecArray;
      const ordered = bullet === null;
      if (list === null || list.ordered !== ordered) {
        endList();
        list = { ordered, start: ordered ? Number(match[1]) : 1, items: [] };
      }
      list.items.push(match[2]);
      continue;
    }

    if (list !== null && /^\s+\S/.test(line)) {
      // An indented line carries on the item above it.
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }

    endList();
    paragraph.push(line.trim());
  }

  endParagraph();
  endList();
  return blocks;
}
