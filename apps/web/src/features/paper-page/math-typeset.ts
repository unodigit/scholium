/**
 * Typesetting the math of the reading column with KaTeX.
 *
 * The paragraphs arrive as plain text and are server-rendered as plain text, so
 * a shared link and a reader with no JavaScript get every formula as the LaTeX
 * the author wrote. Once the page is running, {@link typesetParagraphs} swaps
 * each paragraph that has math for typeset text: KaTeX's HTML for the eye and
 * its MathML for assistive technology (docs/design.md §9: "Math exposed as
 * MathML via KaTeX").
 *
 * - **KaTeX loads only when a paragraph has math** ({@link loadKatex}); a paper
 *   without any never fetches it.
 * - **A formula that cannot be typeset is shown as written**, delimiters and
 *   all, not as a red error and not half-rendered: the reader sees what the
 *   author typed and can judge it for themselves.
 * - **Input is not trusted.** Every command that needs trust (`\href`, `\url`,
 *   `\includegraphics`: anything that could carry a link or a request out of an
 *   uploaded paper) is refused, macro expansion is bounded, and sizes are
 *   capped, so a hostile formula can neither link out, nor hang the tab, nor
 *   paint a page-sized box over the paper.
 * - **It is safe to repeat.** A paragraph that has been typeset is marked and
 *   skipped, so a re-run (a second render, StrictMode's double effect) changes
 *   nothing; a paragraph whose text React has since replaced has lost its mark
 *   and is typeset again.
 *
 * It edits the DOM that React rendered, which is safe only because of what the
 * annotation component renders: each paragraph is a `<p>` whose one child is a
 * string, and React replaces such a child wholesale (`textContent`) or not at
 * all, never node by node.
 */

import { mathPlan, type MathSegment } from "./math";

/** The slice of KaTeX the column uses, so tests and callers can pass their own. */
export interface MathRenderer {
  renderToString(
    tex: string,
    options?: {
      displayMode?: boolean;
      throwOnError?: boolean;
      output?: "html" | "mathml" | "htmlAndMathml";
      trust?: boolean | ((context: unknown) => boolean);
      strict?: boolean | "ignore" | "warn" | "error";
      maxExpand?: number;
      maxSize?: number;
    },
  ): string;
}

/** Loads the renderer. Rejects if it cannot be fetched. */
export type LoadMath = () => Promise<MathRenderer>;

/** Marks the element a typeset paragraph's content sits in. */
export const TYPESET_ATTRIBUTE = "data-ppg-typeset";

/** Fetch KaTeX (its own chunk, only when asked for). */
export const loadKatex: LoadMath = async () => (await import("katex")).default;

/** The most macro expansions one formula may make (KaTeX's own default). */
const MAX_EXPAND = 1000;

/**
 * The largest size, in ems, a formula may ask for (a `\rule`, a `\hspace`, a
 * `\kern`). KaTeX's default is no limit, so `\rule{1000em}{1000em}` in an
 * uploaded paper would paint a box over the whole page. A real formula's
 * biggest piece (a tall fraction or matrix) is a few ems.
 */
const MAX_SIZE = 10;

/**
 * The formula as markup, or `null` if it cannot be shown as typeset math.
 *
 * That is two cases. KaTeX cannot parse it (it throws). Or it uses a command
 * that needs trust (`\href`, `\url`, `\includegraphics`…): KaTeX does not throw
 * for those, it draws the command's name in red and drops its arguments, which
 * would misstate the formula. `trust` is a function that refuses every such
 * command and notes that it did, so that formula is shown as written too.
 */
function renderFormula(renderer: MathRenderer, segment: MathSegment): string | null {
  let refused = false;
  try {
    const markup = renderer.renderToString(segment.tex, {
      displayMode: segment.display,
      throwOnError: true,
      output: "htmlAndMathml",
      trust: () => {
        refused = true;
        return false;
      },
      strict: "ignore",
      maxExpand: MAX_EXPAND,
      maxSize: MAX_SIZE,
    });
    return refused ? null : markup;
  } catch {
    return null;
  }
}

/** Whether any of these paragraphs has something to typeset. */
export function hasMath(paragraphs: ReadonlyArray<{ readonly text: string }>): boolean {
  return paragraphs.some((paragraph) => mathPlan(paragraph.text) !== null);
}

/**
 * Typeset one paragraph's element from its source text.
 *
 * @returns whether the element was changed: `false` for a paragraph with no
 *   math and for one that has already been typeset.
 */
export function typesetParagraph(
  element: Element,
  text: string,
  renderer: MathRenderer,
): boolean {
  const plan = mathPlan(text);
  if (plan === null) {
    return false;
  }
  if (element.firstElementChild?.hasAttribute(TYPESET_ATTRIBUTE)) {
    return false;
  }

  const document = element.ownerDocument;
  const content = document.createElement("span");
  content.setAttribute(TYPESET_ATTRIBUTE, "");

  for (const segment of plan) {
    if (segment.kind === "text") {
      content.append(document.createTextNode(segment.text));
      continue;
    }
    const markup = renderFormula(renderer, segment);
    if (markup === null) {
      content.append(document.createTextNode(segment.source));
      continue;
    }
    const formula = document.createElement("span");
    formula.className = segment.display ? "ppg-math ppg-math--display" : "ppg-math";
    // KaTeX's own output for a formula with `trust` off: it escapes the input
    // and emits only its markup, which is what this property is for.
    formula.innerHTML = markup;
    content.append(formula);
  }

  element.replaceChildren(content);
  return true;
}

/**
 * Typeset every paragraph under `root` that has math.
 *
 * A paragraph is found by its `data-paragraph-id` (the annotation component
 * puts it on each `<p>`) and typeset from the text the paragraph was given, so
 * the source is never read back out of markup that has already been changed.
 *
 * @returns how many paragraphs were changed.
 */
export function typesetParagraphs(
  root: ParentNode,
  paragraphs: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  renderer: MathRenderer,
): number {
  const texts = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]));
  let changed = 0;
  for (const element of root.querySelectorAll("p[data-paragraph-id]")) {
    const text = texts.get(element.getAttribute("data-paragraph-id") ?? "");
    if (text !== undefined && typesetParagraph(element, text, renderer)) {
      changed += 1;
    }
  }
  return changed;
}
