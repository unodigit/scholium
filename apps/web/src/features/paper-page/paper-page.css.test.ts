import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for paper-page.css (and the route's shell) against
 * docs/design.md §3 (tokens), §5.2 (the paper page: a 720 px reading column and
 * a 360 px margin panel), §9 (accessibility) and §10 (responsive behaviour).
 *
 * The stylesheets are read as shipped so a hard-coded colour, a typo'd token
 * (which CSS silently ignores) or a lost focus ring fails here rather than in
 * front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "../../styles/tokens.css"), "utf8");

function read(path: string): { source: string; rules: string } {
  const source = readFileSync(path, "utf8");
  // Rules only: the header comments deliberately name colours and tokens.
  return { source, rules: source.replace(/\/\*[\s\S]*?\*\//g, "") };
}

const page = read(join(here, "paper-page.css"));
const shell = read(join(here, "../../app/(paper-page)/paper-page-shell.css"));

/** Selector + declarations of every rule, flattening @media blocks. */
function blocks(rules: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (let match = pattern.exec(rules); match; match = pattern.exec(rules)) {
    out.push({
      selector: match[1].trim().replace(/^@media[^{]*$/, ""),
      body: match[2],
    });
  }
  return out;
}

/** The declarations of every rule whose selector list includes `selector`. */
function declarations(css: { rules: string }, selector: string): string {
  return blocks(css.rules)
    .filter(({ selector: list }) =>
      list.split(",").some((part) => part.trim() === selector),
    )
    .map(({ body }) => body)
    .join("\n");
}

/**
 * The text inside every `@media <query> { … }` block, brace-matched, so a rule
 * can be asserted to live (or not live) at one width. `query` is the text after
 * `@media `, exactly as written.
 */
function inMedia(css: { rules: string }, query: string): string {
  const inside: string[] = [];
  const marker = `@media ${query} {`;
  for (
    let at = css.rules.indexOf(marker);
    at !== -1;
    at = css.rules.indexOf(marker, at + marker.length)
  ) {
    const open = at + marker.length - 1;
    let depth = 0;
    let end = open;
    for (; end < css.rules.length; end += 1) {
      if (css.rules[end] === "{") depth += 1;
      if (css.rules[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    inside.push(css.rules.slice(open + 1, end));
  }
  return inside.join("\n");
}

/** `declarations`, but only the rules written inside one `@media` query. */
function declarationsIn(css: { rules: string }, query: string, selector: string): string {
  return declarations({ rules: inMedia(css, query) }, selector);
}

/** The `@keyframes` rule called `name`, brace-matched. */
function keyframes(css: { rules: string }, name: string): string {
  const at = css.rules.indexOf(`@keyframes ${name} {`);
  if (at === -1) return "";
  const open = css.rules.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (; end < css.rules.length; end += 1) {
    if (css.rules[end] === "{") depth += 1;
    if (css.rules[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return css.rules.slice(open + 1, end);
}

/** Below 1280 px: where the margin panel can be put away. */
const COLLAPSIBLE = "(width < 80rem)";
/** Under 1024 px: the bottom sheet. */
const SHEET = "(width < 64rem)";
/** On a phone, where the fixed tab bar is. */
const PHONE = "(width < 40rem)";
/** 1024–1279 px: the drawer. */
const DRAWER = "(64rem <= width < 80rem)";

const ENHANCED = '.ppg-margin[data-enhanced="true"]';

describe.each([
  ["paper-page.css", page],
  ["paper-page-shell.css", shell],
])("%s", (_name, css) => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(css.rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css.rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("only reads custom properties that exist", () => {
    const defined = new Set(
      [
        ...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g),
        ...css.rules.matchAll(/(--[a-z0-9-]+)\s*:/g),
      ].map((match) => match[1]),
    );
    const used = [...css.rules.matchAll(/var\((--[a-z0-9-]+)/g)].map(
      (match) => match[1],
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });

  it("never uses the reserved AI colour: nothing here is AI output", () => {
    expect(css.rules).not.toMatch(/--ai\b/);
  });

  it("casts no shadow: only the annotation popover floats", () => {
    expect(css.rules).not.toMatch(/box-shadow|drop-shadow|text-shadow/);
  });
});

describe("the layout (docs/design.md §5.2)", () => {
  it("sets the reading column at the 720 px token, not a number", () => {
    const main = declarations(page, ".ppg-main");
    expect(main).toMatch(/max-inline-size:\s*var\(--reading-column\)/);
    expect(tokens).toMatch(/--reading-column:\s*45rem/);
  });

  it("sets the margin panel at the 360 px token, beside the paper from 1280 px", () => {
    expect(tokens).toMatch(/--margin-panel:\s*22\.5rem/);
    const wide = page.rules.slice(page.rules.indexOf("@media (min-width: 80rem)"));
    expect(wide).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*var\(--reading-column\)\)\s*var\(--margin-panel\)/,
    );
  });

  it("is one column below 1280 px", () => {
    expect(declarations(page, ".ppg")).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it("keeps the panel in view while the paper scrolls, only where it sits beside it", () => {
    const sticky = blocks(page.rules).filter(({ body }) => /position:\s*sticky/.test(body));
    expect(sticky).toHaveLength(1);
    expect(sticky[0].selector).toBe(".ppg-margin");
    // The sticky rule lives inside the wide media query, so it never traps a
    // stacked panel.
    const wideStart = page.rules.indexOf("@media (min-width: 80rem)", page.rules.indexOf(".ppg-main"));
    expect(page.rules.indexOf("position: sticky")).toBeGreaterThan(wideStart);
  });

  it("sizes the shell to the two columns and no more", () => {
    expect(declarations(shell, ".ppg-shell")).toMatch(
      /max-width:\s*calc\(\s*var\(--reading-column\)\s*\+\s*var\(--margin-panel\)/,
    );
  });

  it("caps reading lines at the 72-character measure", () => {
    expect(declarations(page, ".ppg-abstract-body")).toMatch(
      /max-inline-size:\s*var\(--measure-reading\)/,
    );
    expect(declarations(page, ".ppg-text .pd-paragraph")).toMatch(
      /max-inline-size:\s*var\(--measure-reading\)/,
    );
  });

  it("fits a wide display formula into the column by scrolling it, not by widening the page", () => {
    const display = declarations(page, ".ppg-text .katex-display");
    expect(display).toMatch(/max-inline-size:\s*100%/);
    expect(display).toMatch(/overflow-x:\s*auto/);
  });

  it("keeps the PDF's pages inside the column, each holding its place", () => {
    const pageBox = declarations(page, ".ppg-pdf-page");
    expect(pageBox).toMatch(/inline-size:\s*100%/);
    expect(pageBox).toMatch(/border:\s*1px solid var\(--rule\)/);
    // The canvas fills its box; the box's height comes from the aspect ratio
    // the viewer sets, so the column does not jump as pages are drawn.
    const canvas = declarations(page, ".ppg-pdf-canvas");
    expect(canvas).toMatch(/inline-size:\s*100%/);
    expect(canvas).toMatch(/display:\s*block/);
  });

  it("sets the abstract in the reading serif at the reading size", () => {
    const abstract = declarations(page, ".ppg-abstract-body");
    expect(abstract).toMatch(/font-family:\s*var\(--family-serif\)/);
    expect(abstract).toMatch(/font-size:\s*var\(--type-reading\)/);
    expect(abstract).toMatch(/line-height:\s*var\(--leading-reading\)/);
  });
});

describe("accessibility (docs/design.md §9)", () => {
  it("gives every control a visible 2 px focus ring in the focus colour", () => {
    for (const selector of [
      ".ppg-action:focus-visible",
      ".ppg-tab:focus-visible",
      ".ppg-details:focus-visible",
    ]) {
      expect(declarations(page, selector)).toMatch(
        /outline:\s*2px solid var\(--focus-ring\)/,
      );
    }
  });

  it("makes actions and tabs at least 44 px tall on touch", () => {
    const coarse = page.rules.slice(page.rules.indexOf("@media (pointer: coarse)"));
    expect(coarse).toMatch(/\.ppg-action\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/);
    expect(coarse).toMatch(/\.ppg-tab\s*\{[^}]*min-block-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/);
  });

  it("does not rely on colour alone for the open tab or the current view", () => {
    // Fill, border and weight change together with the colour.
    const selected = declarations(page, '.ppg-tab[aria-selected="true"]');
    expect(selected).toMatch(/border-color/);
    expect(selected).toMatch(/background-color/);
    expect(selected).toMatch(/font-weight:\s*600/);

    const current = declarations(page, '.ppg-action[aria-current="true"]');
    expect(current).toMatch(/border-color/);
    expect(current).toMatch(/background-color/);
  });

  it("shows an unavailable action as dashed and quiet, not as a working one", () => {
    const disabled = declarations(page, '.ppg-action[aria-disabled="true"]');
    expect(disabled).toMatch(/border-style:\s*dashed/);
    expect(disabled).toMatch(/color:\s*var\(--ink-2\)/);
  });

  it("keeps hidden tab panels hidden whatever else sets their display", () => {
    expect(declarations(page, ".ppg-tabpanel[hidden]")).toMatch(/display:\s*none/);
  });

  it("keeps the hidden rendition hidden whatever else sets its display", () => {
    // The HTML stays mounted under the PDF (and the PDF under the HTML), so
    // `hidden` is what takes the one that is not showing out of the page.
    expect(declarations(page, ".ppg-view[hidden]")).toMatch(/display:\s*none/);
  });

  it("gives the PDF view's link a visible 2 px focus ring in the focus colour", () => {
    expect(declarations(page, ".ppg-pdf-link:focus-visible")).toMatch(
      /outline:\s*2px solid var\(--focus-ring\)/,
    );
  });

  it("hides text visually without removing it from assistive technology", () => {
    const hidden = declarations(page, ".ppg-visually-hidden");
    expect(hidden).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(hidden).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });
});

describe("the compare view (feature 186)", () => {
  it("sets diff paragraphs as reading text at the 72-character measure", () => {
    const text = declarations(page, ".ppg-compare-text");
    expect(text).toMatch(/font-family:\s*var\(--family-serif\)/);
    expect(text).toMatch(/font-size:\s*var\(--type-reading\)/);
    expect(text).toMatch(/line-height:\s*var\(--leading-reading\)/);
    expect(text).toMatch(/max-inline-size:\s*var\(--measure-reading\)/);
  });

  it("reinforces added and removed with a border and tint, never colour alone", () => {
    expect(declarations(page, '.ppg-compare-item[data-kind="added"]')).toMatch(
      /border-inline-start-color:\s*var\(--verified\)/,
    );
    expect(declarations(page, '.ppg-compare-item[data-kind="removed"]')).toMatch(
      /border-inline-start-color:\s*var\(--critical\)/,
    );
    expect(declarations(page, ".ppg-compare-text ins")).toMatch(
      /background-color:\s*var\(--verified-soft\)/,
    );
    expect(declarations(page, ".ppg-compare-text del")).toMatch(
      /background-color:\s*var\(--critical-soft\)/,
    );
    // The words on the tint keep --ink, which clears 4.5:1 in both themes.
    expect(declarations(page, ".ppg-compare-text ins")).toMatch(
      /color:\s*var\(--ink\)/,
    );
    expect(declarations(page, ".ppg-compare-text del")).toMatch(
      /color:\s*var\(--ink\)/,
    );
  });

  it("gives the back and read links a visible focus ring", () => {
    expect(declarations(page, ".ppg-compare a:focus-visible")).toMatch(
      /outline:\s*2px solid var\(--focus-ring\)/,
    );
  });
});

describe("the Invite reviewer form (feature 187)", () => {
  it("gives every control a visible 2 px focus ring in the focus colour", () => {
    for (const selector of [
      ".ppg-invite-input:focus-visible",
      ".ppg-invite-send:focus-visible",
      ".ppg-invite-close:focus-visible",
      ".ppg-invite-toggle:focus-visible",
      ".ppg-invite-link:focus-visible",
    ]) {
      expect(declarations(page, selector)).toMatch(
        /outline:\s*2px solid var\(--focus-ring\)/,
      );
    }
  });

  it("makes the field and both buttons at least 44 px tall", () => {
    for (const selector of [".ppg-invite-input", ".ppg-invite-send", ".ppg-invite-close"]) {
      expect(declarations(page, selector)).toMatch(
        /min-block-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/,
      );
    }
  });

  it("keeps a closed panel hidden whatever else sets its display", () => {
    // The form stays mounted while closed so a half-typed DID survives, so the
    // `hidden` attribute is what takes it out of the page.
    expect(declarations(page, ".ppg-invite-panel[hidden]")).toMatch(/display:\s*none/);
  });

  it("sets a DID in the code face, because it is read character by character", () => {
    for (const selector of [".ppg-invite-input", ".ppg-invite-did"]) {
      expect(declarations(page, selector)).toMatch(/font-family:\s*var\(--family-mono\)/);
    }
  });

  it("does not rely on colour alone for a mistake or for an open form", () => {
    // The words stay in --ink; the colour is on the icon, beside the words.
    expect(declarations(page, ".ppg-invite-error")).toMatch(/color:\s*var\(--ink\)/);
    expect(declarations(page, ".ppg-invite-icon--critical")).toMatch(
      /color:\s*var\(--critical\)/,
    );
    expect(declarations(page, ".ppg-invite-icon--verified")).toMatch(
      /color:\s*var\(--verified\)/,
    );
    // A field with a mistake also changes border, and aria-invalid says so.
    expect(declarations(page, '.ppg-invite-input[aria-invalid="true"]')).toMatch(
      /border-color:\s*var\(--critical\)/,
    );
    // The open button is filled and bordered, as the current view is.
    const open = declarations(page, '.ppg-invite-toggle[aria-expanded="true"]');
    expect(open).toMatch(/border-color/);
    expect(open).toMatch(/background-color/);
  });

  it("takes no room while the live region is empty", () => {
    expect(declarations(page, ".ppg-invite-done:empty")).toMatch(/display:\s*none/);
  });
});

describe("the margin drawer and bottom sheet (docs/design.md §5.2, §10)", () => {
  it("is a drawer from 1024 to 1279 px and a sheet under 1024 px, and nothing from 1280 px", () => {
    // The three queries tile the widths below 1280 px with no gap and no overlap.
    expect(page.rules).toContain(`@media ${COLLAPSIBLE} {`);
    expect(page.rules).toContain(`@media ${SHEET} {`);
    expect(page.rules).toContain(`@media ${DRAWER} {`);

    // Nothing is taken out of the flow except below 1280 px, so the beside-the-paper
    // layout is exactly what it was.
    const fixedAnywhere = page.rules.match(/position:\s*fixed/g) ?? [];
    const fixedBelowWide = inMedia(page, COLLAPSIBLE).match(/position:\s*fixed/g) ?? [];
    expect(fixedAnywhere.length).toBeGreaterThan(0);
    expect(fixedAnywhere).toHaveLength(fixedBelowWide.length);
  });

  it("applies only once the page runs, so a page without JavaScript keeps the panel in the flow", () => {
    // The plain panel rule never positions or hides anything.
    const plain = declarations(page, ".ppg-margin");
    expect(plain).not.toMatch(/position:\s*fixed/);
    expect(plain).not.toMatch(/display:\s*none/);

    // Every rule that fixes the panel, or puts its body away, asks for data-enhanced.
    for (const { selector, body } of blocks(inMedia(page, COLLAPSIBLE))) {
      if (/position:\s*fixed/.test(body) || /display:\s*none/.test(body)) {
        expect(selector).toContain('[data-enhanced="true"]');
      }
    }
    for (const query of [SHEET, PHONE, DRAWER]) {
      for (const { selector, body } of blocks(inMedia(page, query))) {
        if (/^\.ppg-margin\b/.test(selector) && /inset-|inline-size|max-block-size/.test(body)) {
          expect(selector).toContain('[data-enhanced="true"]');
        }
      }
    }
  });

  it("does not show the toggle unless the page runs and the panel can be put away", () => {
    expect(declarations(page, ".ppg-margin-toggle")).toMatch(/display:\s*none/);
    expect(declarationsIn(page, COLLAPSIBLE, `${ENHANCED} .ppg-margin-toggle`)).toMatch(
      /display:\s*flex/,
    );
  });

  describe("as a bottom sheet (under 1024 px)", () => {
    it("rests on the bottom edge, as wide as the reading column at most, rounded on top", () => {
      const sheet = declarationsIn(page, SHEET, ENHANCED);
      expect(sheet).toMatch(/inset-block-end:\s*0/);
      expect(sheet).toMatch(/inset-inline:\s*0/);
      expect(sheet).toMatch(/margin-inline:\s*auto/);
      expect(sheet).toMatch(
        /border-radius:\s*var\(--corner-card\) var\(--corner-card\) 0 0/,
      );
      // The reading column's width comes from the plain panel rule; the sheet
      // must not undo it.
      expect(declarations(page, ".ppg-margin")).toMatch(
        /max-inline-size:\s*var\(--reading-column\)/,
      );
      expect(sheet).not.toMatch(/max-inline-size/);
    });

    it("rises to no more than 80% of the screen, leaving the paper's top in view", () => {
      const sheet = declarationsIn(page, SHEET, ENHANCED);
      expect(sheet).toMatch(/max-block-size:\s*80vh/);
      expect(sheet).toMatch(/max-block-size:\s*80dvh/);
    });

    it("rests on the tab bar on a phone, by the bar's own height", () => {
      const phone = declarationsIn(page, PHONE, ENHANCED);
      expect(phone).toMatch(
        /inset-block-end:\s*calc\(var\(--space-unit\) \* 14 \+ env\(safe-area-inset-bottom, 0px\)\)/,
      );

      // 14 × 4 px is the 56 px of components/nav's bar, so they stay in step.
      const nav = readFileSync(join(here, "../../components/nav/nav.css"), "utf8");
      expect(nav).toMatch(/\.gn-tabbar\s*\{[^}]*height:\s*calc\(56px \+ env\(safe-area-inset-bottom/);
    });

    it("points its arrow up to open it and down to put it away", () => {
      expect(
        declarationsIn(page, SHEET, '.ppg-margin[data-open="false"] .ppg-margin-chevron'),
      ).toMatch(/transform:\s*rotate\(180deg\)/);
      // Open is the arrow's own direction (down): no rule turns it.
      expect(
        declarationsIn(page, SHEET, '.ppg-margin[data-open="true"] .ppg-margin-chevron'),
      ).toBe("");
    });
  });

  describe("as a drawer (1024 to 1279 px)", () => {
    it("is fixed to the inline end, level with the wide layout's panel, 360 px when open", () => {
      const drawer = declarationsIn(page, DRAWER, ENHANCED);
      expect(drawer).toMatch(/inset-inline-end:\s*0/);
      expect(drawer).toMatch(/inline-size:\s*var\(--margin-panel\)/);
      // The same offset as the sticky panel from 1280 px: clear of the 64 px nav.
      expect(drawer).toMatch(
        /inset-block-start:\s*calc\(var\(--space-unit\) \* 16 \+ var\(--space-unit\) \* 4\)/,
      );
      expect(drawer).toMatch(/max-block-size:\s*calc\(100dvh - /);
      expect(tokens).toMatch(/--margin-panel:\s*22\.5rem/);
    });

    it("is a narrow tab, wider than a 44 px target, while put away", () => {
      const away = declarationsIn(
        page,
        DRAWER,
        `${ENHANCED}[data-open="false"]`,
      );
      // 12 × 4 px = 48 px: the 1 px border takes a little of it.
      expect(away).toMatch(/inline-size:\s*calc\(var\(--space-unit\) \* 12\)/);
      expect(
        declarationsIn(
          page,
          DRAWER,
          '.ppg-margin[data-open="false"] .ppg-margin-toggle-label',
        ),
      ).toMatch(/writing-mode:\s*vertical-rl/);
    });

    it("points its arrow the way it will move", () => {
      expect(
        declarationsIn(page, DRAWER, '.ppg-margin[data-open="false"] .ppg-margin-chevron'),
      ).toMatch(/transform:\s*rotate\(90deg\)/);
      expect(
        declarationsIn(page, DRAWER, '.ppg-margin[data-open="true"] .ppg-margin-chevron'),
      ).toMatch(/transform:\s*rotate\(-90deg\)/);
    });
  });

  describe("collapsing", () => {
    it("takes the body out of the page rather than moving it aside, so it leaves the tab order", () => {
      const away = declarationsIn(
        page,
        COLLAPSIBLE,
        `${ENHANCED}[data-open="false"] .ppg-margin-body`,
      );
      expect(away).toMatch(/display:\s*none/);
      // Nothing hides the body at 1280 px and up, whatever the open state.
      const outside = blocks(page.rules)
        .filter(({ selector }) => selector.includes(".ppg-margin-body"))
        .filter(({ body }) => /display:\s*none/.test(body));
      for (const { selector } of outside) {
        expect(selector).toContain('[data-open="false"]');
      }
      expect(
        inMedia(page, "(min-width: 80rem)").includes(".ppg-margin-body"),
      ).toBe(false);
    });

    it("scrolls the body on its own, so the bar stays and the paper does not move", () => {
      const body = declarationsIn(page, COLLAPSIBLE, `${ENHANCED} .ppg-margin-body`);
      expect(body).toMatch(/overflow-y:\s*auto/);
      expect(body).toMatch(/min-block-size:\s*0/);
      expect(body).toMatch(/overscroll-behavior:\s*contain/);
    });

    it("sits under the nav, the record side sheet and the toast", () => {
      const frame = declarationsIn(page, COLLAPSIBLE, ENHANCED);
      const z = Number(/z-index:\s*(\d+)/.exec(frame)?.[1]);
      const nav = readFileSync(join(here, "../../components/nav/nav.css"), "utf8");
      const navZ = Number(/\.gn-header\s*\{[^}]*z-index:\s*(\d+)/.exec(nav)?.[1]);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(navZ);
    });
  });

  describe("the toggle (docs/design.md §9)", () => {
    it("is at least 44 px tall", () => {
      expect(
        declarationsIn(page, COLLAPSIBLE, `${ENHANCED} .ppg-margin-toggle`),
      ).toMatch(/min-block-size:\s*calc\(var\(--space-unit\)\s*\*\s*11\)/);
    });

    it("has a visible 2 px focus ring in the focus colour, drawn inward because the frame clips", () => {
      const ring = declarationsIn(page, COLLAPSIBLE, ".ppg-margin-toggle:focus-visible");
      expect(ring).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
      expect(ring).toMatch(/outline-offset:\s*-2px/);
    });

    it("marks the open panel by a rule under the bar, not by colour alone", () => {
      expect(
        declarationsIn(
          page,
          COLLAPSIBLE,
          `${ENHANCED}[data-open="true"] .ppg-margin-toggle`,
        ),
      ).toMatch(/border-block-end:\s*1px solid var\(--rule\)/);
    });

    it("says what is inside in the quiet text colour, on one line", () => {
      const hint = declarations(page, ".ppg-margin-toggle-hint");
      expect(hint).toMatch(/color:\s*var\(--ink-2\)/);
      expect(hint).toMatch(/white-space:\s*nowrap/);
      expect(hint).toMatch(/text-overflow:\s*ellipsis/);
    });
  });

  describe("motion (docs/design.md §3)", () => {
    it("rises and slides in over the base duration, ease-out, on opacity and transform only", () => {
      expect(declarationsIn(page, SHEET, `${ENHANCED}[data-open="true"] .ppg-margin-body`)).toMatch(
        /animation:\s*ppg-margin-rise var\(--duration-base\) var\(--ease-decel\)/,
      );
      expect(
        declarationsIn(page, DRAWER, `${ENHANCED}[data-open="true"] .ppg-margin-body`),
      ).toMatch(/animation:\s*ppg-margin-slide var\(--duration-base\) var\(--ease-decel\)/);

      for (const name of ["ppg-margin-rise", "ppg-margin-slide"]) {
        const frames = keyframes(page, name);
        expect(frames).not.toBe("");
        const properties = [...frames.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
        expect(new Set(properties)).toEqual(new Set(["opacity", "transform"]));
      }
    });

    it("turns the arrow over the fast duration, ease-out", () => {
      expect(declarations(page, ".ppg-margin-chevron")).toMatch(
        /transition:\s*transform var\(--duration-fast\) var\(--ease-decel\)/,
      );
    });
  });
});

describe("selectors", () => {
  it("all start from a ppg class, so nothing leaks into other features", () => {
    const selectors = blocks(page.rules)
      .flatMap(({ selector }) => selector.split(","))
      .map((selector) => selector.trim())
      // The steps inside an @keyframes rule are not selectors.
      .filter((selector) => !/^(?:from|to|\d+%)$/.test(selector))
      .filter((selector) => selector !== "");

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      // `.ppg` (the layout root) or `.ppg-…`; the annotation component's own
      // classes are only ever reached through `.ppg-text`.
      expect(selector).toMatch(/^\.ppg(?:-|$|[\s:[])/);
    }
  });
});
