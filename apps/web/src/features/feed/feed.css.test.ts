import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contract tests for the feed's stylesheets against docs/design.md §3, §5.1
 * and §9: tokens only, a serif title, a two-line abstract, no shadows, status
 * never by colour alone, 44px touch targets.
 *
 * The stylesheets are read as shipped so a hard-coded colour or a dropped
 * line clamp fails here rather than in front of a reader.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Rules only: the header comments deliberately name colours and tokens. */
function rulesOf(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const feed = rulesOf(join(here, "feed.css"));
const shell = rulesOf(join(here, "../../app/(feed)/feed-shell.css"));

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) {
    throw new Error(`No rule for ${selector}`);
  }
  return match[1];
}

describe.each([
  ["features/feed/feed.css", feed],
  ["app/(feed)/feed-shell.css", shell],
])("%s", (_name, rules) => {
  it("contains no hard-coded colour: every colour is a design token", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/i);
  });

  it("never uses the reserved AI colour", () => {
    expect(rules).not.toMatch(/--ai\b/);
    expect(rules).not.toMatch(/--ai-soft\b/);
  });

  it("casts no shadow (design.md §3: only the annotation popover floats)", () => {
    expect(rules).not.toMatch(/box-shadow|text-shadow|drop-shadow|--popover-shadow/);
  });
});

describe("a row", () => {
  it("sets the title in the serif face at 600", () => {
    const title = rule(feed, ".fd-row-title");
    expect(title).toMatch(/font-family:\s*var\(--family-serif\)/);
    expect(title).toMatch(/font-weight:\s*var\(--weight-title\)/);
  });

  it("keeps the title ink until it is pointed at", () => {
    expect(rule(feed, ".fd-row-title a")).toMatch(/color:\s*var\(--ink\)/);
    expect(rule(feed, ".fd-row-title a:hover")).toMatch(/color:\s*var\(--accent\)/);
  });

  it("sets authors, categories, version and age as Inter 13/18 meta", () => {
    const meta = rule(feed, ".fd-row-meta");
    expect(meta).toMatch(/font-family:\s*var\(--family-sans\)/);
    expect(meta).toMatch(/font-size:\s*var\(--type-meta\)/);
    expect(meta).toMatch(/line-height:\s*var\(--leading-meta\)/);
    expect(meta).toMatch(/color:\s*var\(--ink-2\)/);
  });

  it("keeps a version and an age on one line", () => {
    expect(rule(feed, ".fd-row-version,\n.fd-row-age")).toMatch(/white-space:\s*nowrap/);
  });

  it("clamps the abstract to two lines", () => {
    const abstract = rule(feed, ".fd-row-abstract");
    expect(abstract).toMatch(/-webkit-line-clamp:\s*2\b/);
    expect(abstract).toMatch(/\bline-clamp:\s*2\b/);
    expect(abstract).toMatch(/display:\s*-webkit-box/);
    expect(abstract).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(abstract).toMatch(/overflow:\s*hidden/);
  });

  it("sets the abstract in the reading face", () => {
    expect(rule(feed, ".fd-row-abstract")).toMatch(/font-family:\s*var\(--family-serif\)/);
  });

  it("separates rows with a 1px rule", () => {
    expect(rule(feed, ".fd-row")).toMatch(/border-bottom:\s*1px solid var\(--rule\)/);
  });

  it("wraps the status chips", () => {
    expect(rule(feed, ".fd-row-chips")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("trails each meta part with a dot, so a wrapped line never starts with one", () => {
    // Generated content with empty alt text: it is not read aloud either.
    expect(feed).toMatch(
      /\.fd-row-meta > :not\(:last-child\)::after\s*\{[^}]*content:\s*"·" \/ ""/,
    );
    expect(feed).not.toMatch(/\.fd-row-meta > \* \+ \*::before/);
  });
});

describe("tabs and selectors", () => {
  it("marks the current tab by an underline and a darker word, not by colour alone", () => {
    const active = rule(feed, ".fd-tab--active,\n.fd-tab[aria-current=\"page\"]");
    expect(active).toMatch(/color:\s*var\(--ink\)/);
    expect(active).toMatch(/border-bottom-color:\s*var\(--accent\)/);
    expect(rule(feed, ".fd-tab")).toMatch(/border-bottom:\s*2px solid transparent/);
  });

  it("keeps every control at least 44px tall (touch target, design.md §9)", () => {
    expect(rule(feed, ".fd-tab")).toMatch(/min-height:\s*44px/);
    expect(rule(feed, ".fd-select select,\n.fd-apply")).toMatch(/min-height:\s*44px/);
    expect(rule(feed, ".fd-button")).toMatch(/min-height:\s*44px/);
  });

  it("rounds controls at 6px and uses the UI type", () => {
    const control = rule(feed, ".fd-select select,\n.fd-apply");
    expect(control).toMatch(/border-radius:\s*var\(--corner-control\)/);
    expect(control).toMatch(/font-size:\s*var\(--type-ui\)/);
  });

  it("never removes the keyboard focus ring", () => {
    expect(feed).not.toMatch(/outline:\s*(?:none|0)\b/);
  });

  it("gives the selectors their own full-width line on a phone", () => {
    expect(feed).toMatch(/@media \(max-width:\s*639px\)\s*\{[^@]*\.fd-selectors\s*\{[^}]*width:\s*100%/);
  });
});

describe("states", () => {
  it("shows an error as a critical-edged panel with its words in ink", () => {
    const error = rule(feed, ".fd-error");
    expect(error).toMatch(/border:\s*1px solid var\(--critical\)/);
    expect(error).toMatch(/background:\s*var\(--critical-soft\)/);
    expect(error).toMatch(/color:\s*var\(--ink\)/);
  });

  it("dims a disabled button and shows it is not clickable", () => {
    const disabled = rule(feed, ".fd-button:disabled");
    expect(disabled).toMatch(/cursor:\s*not-allowed/);
    expect(disabled).toMatch(/opacity:/);
  });
});

describe("the shell", () => {
  it("centres the feed in a column of its own width", () => {
    const rules = rule(shell, ".fd-shell");
    expect(rules).toMatch(/max-width:\s*56rem/);
    expect(rules).toMatch(/margin:\s*0 auto/);
  });

  it("leaves room for the fixed bottom bar by padding the end of the page", () => {
    expect(rule(shell, ".fd-shell")).toMatch(/padding:[^;]*calc\(var\(--space-unit\) \* 16\)/);
  });
});
