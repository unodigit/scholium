/**
 * Finding the math in a paragraph of paper text.
 *
 * `GET /v1/papers/{id}/v/{n}/text` answers with plain paragraphs. When a
 * paragraph carries LaTeX it is written the way LaTeX writes it, so the
 * reading column splits it into text and formulas and hands each formula to
 * KaTeX (`math-typeset.ts`). This module only does the splitting: pure
 * functions, no DOM, no KaTeX.
 *
 * Four delimiters are recognised:
 *
 * | Written | Shown |
 * | --- | --- |
 * | `\( … \)` | inline |
 * | `$ … $` | inline |
 * | `\[ … \]` | display (its own line) |
 * | `$$ … $$` | display |
 *
 * Prose is full of dollar signs that are not math ("it costs $5 to $10"), and
 * wrongly turning a price into a formula would change what the paper says. So
 * `$ … $` follows pandoc's rules: the opening `$` must be followed by
 * something other than a space, the closing `$` must not follow a space and
 * must not be followed by a digit. `\$` is a literal dollar sign.
 *
 * A delimiter with no partner, or with nothing between the pair, stays as
 * the text it was. Nothing is ever dropped: concatenating every segment's
 * `source` gives the paragraph back.
 */

/** A run of ordinary text. `text` is what to show (a `\$` is already `$`). */
export interface TextSegment {
  readonly kind: "text";
  readonly text: string;
}

/** One formula. */
export interface MathSegment {
  readonly kind: "math";
  /** The LaTeX between the delimiters, as written. */
  readonly tex: string;
  /** Display math sits on its own line; inline math runs with the text. */
  readonly display: boolean;
  /** The formula with its delimiters, as written: what to show if it cannot be typeset. */
  readonly source: string;
}

export type ParagraphSegment = TextSegment | MathSegment;

/**
 * The longest formula looked for between two delimiters. A real formula is far
 * shorter; the cap keeps a stray `$` in a very long paragraph from sending the
 * scan to the end of it, over and over.
 */
export const MAX_MATH_LENGTH = 5000;

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * Where `close` next appears at or after `from`, within {@link MAX_MATH_LENGTH}
 * characters, or `-1`. A backslash escapes the character after it, so `\$`
 * and `\\` never end a formula; `close` itself may begin with a backslash
 * (`\)`), so it is tried before the escape is skipped.
 */
function findClose(text: string, from: number, close: string): number {
  const limit = Math.min(text.length, from + MAX_MATH_LENGTH);
  for (let index = from; index < limit; ) {
    if (text.startsWith(close, index)) {
      return index;
    }
    index += text[index] === "\\" ? 2 : 1;
  }
  return -1;
}

/**
 * Where the `$` that closes an inline formula opened just before `from` is, or
 * `-1`.
 *
 * An unescaped `$` never occurs inside an inline formula (in LaTeX it would end
 * it), so the first one met is the end of the search: it closes the formula if
 * it passes the closing rule, and otherwise shows that the opening `$` was not
 * an opener at all. In "$5 to $10 or $x$" the first two `$` are prices and
 * `$x$` is math, rather than one long formula from the first `$` to the last.
 */
function findInlineClose(text: string, from: number): number {
  const limit = Math.min(text.length, from + MAX_MATH_LENGTH);
  for (let index = from; index < limit; ) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "$") {
      return index > from && !isSpace(text[index - 1]) && !isDigit(text[index + 1])
        ? index
        : -1;
    }
    index += 1;
  }
  return -1;
}

/**
 * Split a paragraph into text and formulas, in reading order.
 *
 * A paragraph with no math and no `\$` comes back as one text segment holding
 * the paragraph unchanged; an empty one as no segments.
 */
export function splitMath(text: string): ParagraphSegment[] {
  const segments: ParagraphSegment[] = [];
  let plain = "";

  const flush = (): void => {
    if (plain !== "") {
      segments.push({ kind: "text", text: plain });
      plain = "";
    }
  };

  /** Take the formula between `open` and `close` if there is one; report whether it did. */
  const take = (
    start: number,
    open: string,
    close: string,
    display: boolean,
    end: number,
  ): number => {
    // `end` is where the closing delimiter starts; -1 means there is none.
    const tex = end === -1 ? "" : text.slice(start + open.length, end);
    if (end === -1 || tex.trim() === "") {
      return -1;
    }
    flush();
    const next = end + close.length;
    segments.push({
      kind: "math",
      tex,
      display,
      source: text.slice(start, next),
    });
    return next;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    let taken = -1;

    if (char === "\\") {
      if (next === "$") {
        plain += "$";
        index += 2;
        continue;
      }
      if (next === "(") {
        taken = take(index, "\\(", "\\)", false, findClose(text, index + 2, "\\)"));
      } else if (next === "[") {
        taken = take(index, "\\[", "\\]", true, findClose(text, index + 2, "\\]"));
      } else if (next === "\\") {
        // A LaTeX line break, not an escape for what follows it.
        plain += "\\\\";
        index += 2;
        continue;
      }
    } else if (char === "$") {
      if (next === "$") {
        taken = take(index, "$$", "$$", true, findClose(text, index + 2, "$$"));
        if (taken === -1) {
          // `$$` with no partner is two literal signs, not an opening `$`.
          plain += "$$";
          index += 2;
          continue;
        }
      } else if (!isSpace(next)) {
        taken = take(index, "$", "$", false, findInlineClose(text, index + 1));
      }
    }

    if (taken !== -1) {
      index = taken;
    } else {
      plain += char;
      index += 1;
    }
  }

  flush();
  return segments;
}

/**
 * The segments to show for a paragraph, or `null` when it is plain text that
 * needs nothing done to it (the common case: most paragraphs have no math).
 */
export function mathPlan(text: string): ParagraphSegment[] | null {
  const segments = splitMath(text);
  const plain =
    segments.length === 0 ||
    (segments.length === 1 &&
      segments[0].kind === "text" &&
      segments[0].text === text);
  return plain ? null : segments;
}
