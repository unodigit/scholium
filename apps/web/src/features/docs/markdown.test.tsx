// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chapters,
  headingAnchors,
  type HandbookHeading,
  type HandbookScreenshot,
} from "./handbook";
import { HandbookMarkdown, SECTION_LINK_LABEL, type HandbookMarkdownChapter } from "./markdown";

// The real `Link` needs the App Router's context. This stand-in is an anchor
// that says it came from `next/link`, so the tests can tell a client-side link
// to a docs page from a plain anchor.
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, "data-next-link": "true", ...rest }, children),
  };
});

afterEach(cleanup);

const SHOT_WIDE: HandbookScreenshot = {
  src: "/docs/screenshots/ch01-navigation-bar.webp",
  width: 1440,
  height: 900,
  alt: "The navigation bar on a computer, with the Categories menu open",
  caption: "On a computer, the navigation bar holds search, Categories and Submit.",
  heading: "Where things are",
  source: "02-search-and-discover/05b-categories-menu.png",
};

const SHOT_PHONE: HandbookScreenshot = {
  src: "/docs/screenshots/ch01-phone-navigation.webp",
  width: 390,
  height: 844,
  alt: "A paper page on a phone, with the Home, Search and Submit bar at the bottom",
  caption: "On a phone, the navigation moves to a bar at the bottom of the screen.",
  heading: "Where things are",
  source: "01-read-feed-and-paper/08-paper-header-mobile-390.png",
};

const BODY = `Start with [Your account](02-your-account.md#sign-in-with-a-passkey), then see [below](#where-things-are).
Operators read [the deployment guide](../deploy.md) instead. See also [Scholium](https://example.com/about).

## Where things are

The navigation sits at the top.

### Repeat

First.

## Repeat

Second.

| Term | Meaning |
| --- | --- |
| Anchor | A public timestamp |
| DID | Your public identifier |

## Last section

The end.
`;

/** A chapter whose heading ids come from the same function handbook.ts uses. */
function fixture(
  overrides: Partial<HandbookMarkdownChapter> & { body?: string } = {},
): HandbookMarkdownChapter {
  const found: Array<{ level: 2 | 3; text: string }> = [];
  for (const line of (overrides.body ?? BODY).split("\n")) {
    const match = /^(##|###)\s+(.*)$/.exec(line);
    if (match) found.push({ level: match[1].length as 2 | 3, text: match[2] });
  }
  const ids = headingAnchors(found.map((heading) => heading.text));
  const headings: HandbookHeading[] = found.map((heading, index) => ({
    ...heading,
    id: ids[index],
  }));
  return {
    slug: "how-scholium-works",
    body: BODY,
    headings,
    screenshots: [SHOT_WIDE, SHOT_PHONE],
    ...overrides,
  };
}

function renderChapter(chapter: HandbookMarkdownChapter = fixture()) {
  return render(<HandbookMarkdown chapter={chapter} />);
}

describe("headings", () => {
  it("carries the ids from handbook.ts on ## and ### headings", () => {
    renderChapter();

    const where = screen.getByRole("heading", { level: 2, name: "Where things are" });
    expect(where.id).toBe("where-things-are");

    const sub = screen.getByRole("heading", { level: 3, name: "Repeat" });
    expect(sub.id).toBe("repeat");

    // A repeated heading gets the -1 id handbook.ts gave it, not a second "repeat".
    const again = screen.getByRole("heading", { level: 2, name: "Repeat" });
    expect(again.id).toBe("repeat-1");

    expect(screen.getByRole("heading", { level: 2, name: "Last section" }).id).toBe(
      "last-section",
    );
  });

  it("gives every heading a '#' link to its own anchor, named 'Link to this section'", () => {
    renderChapter();

    const links = screen.getAllByRole("link", { name: SECTION_LINK_LABEL });
    expect(SECTION_LINK_LABEL).toBe("Link to this section");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#where-things-are",
      "#repeat",
      "#repeat-1",
      "#last-section",
    ]);

    for (const link of links) {
      expect(link.textContent).toBe("#");
      const heading = link.closest("h2, h3") as HTMLElement;
      expect(link.getAttribute("href")).toBe(`#${heading.id}`);
      expect(link.getAttribute("aria-label")).toBe("Link to this section");
    }
  });

  it("names a heading by its text, not by the '#' link inside it", () => {
    renderChapter();

    // An exact string would fail if "Link to this section" leaked into the name.
    expect(screen.getByRole("heading", { level: 2, name: "Last section" })).toBeTruthy();
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Where things are#",
      "Repeat#",
      "Repeat#",
      "Last section#",
    ]);
  });

  it("shows the '#' link on hover and on keyboard focus, and keeps it reachable by Tab", () => {
    renderChapter();

    const heading = screen.getByRole("heading", { level: 2, name: "Last section" });
    const link = within(heading).getByRole("link", { name: SECTION_LINK_LABEL });

    // jsdom applies no stylesheet, so assert the utilities that do the showing.
    expect(heading.className).toMatch(/(^|\s)group(\s|$)/);
    const classes = link.className.split(/\s+/);
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("group-hover:opacity-100");
    expect(classes).toContain("group-focus-within:opacity-100");
    expect(classes).toContain("focus-visible:opacity-100");

    // Hidden by opacity, never by display/visibility, so it stays in the tab order.
    expect(link.tabIndex).toBeGreaterThanOrEqual(0);
    expect(classes).not.toContain("hidden");
    expect(classes).not.toContain("invisible");
    expect(link.hasAttribute("aria-hidden")).toBe(false);
  });

  it("leaves a heading that handbook.ts does not list without an id or '#' link", () => {
    renderChapter(fixture({ headings: [] }));

    const heading = screen.getByRole("heading", { level: 2, name: "Last section" });
    expect(heading.id).toBe("");
    expect(within(heading).queryByRole("link")).toBeNull();
    expect(screen.queryAllByRole("link", { name: SECTION_LINK_LABEL })).toHaveLength(0);
  });
});

describe("links", () => {
  it("rewrites a cross-chapter link to a Next Link to /docs/slug#anchor", () => {
    renderChapter();

    const link = screen.getByRole("link", { name: "Your account" });
    expect(link.getAttribute("href")).toBe("/docs/your-account#sign-in-with-a-passkey");
    expect(link.getAttribute("data-next-link")).toBe("true");
  });

  it("points a bare #anchor at the same chapter's docs page", () => {
    renderChapter();

    const link = screen.getByRole("link", { name: "below" });
    expect(link.getAttribute("href")).toBe("/docs/how-scholium-works#where-things-are");
    expect(link.getAttribute("data-next-link")).toBe("true");
  });

  it("leaves an external link as a plain anchor that does not hand over the opener", () => {
    renderChapter();

    const link = screen.getByRole("link", { name: "Scholium" });
    expect(link.getAttribute("href")).toBe("https://example.com/about");
    expect(link.hasAttribute("data-next-link")).toBe(false);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows ../deploy.md as its text with the path in code, not as a link", () => {
    const { container } = renderChapter();

    expect(screen.queryByRole("link", { name: "the deployment guide" })).toBeNull();
    expect(container.querySelector('a[href*="deploy"]')).toBeNull();

    const paragraph = screen.getByText(/Operators read/);
    expect(paragraph.textContent).toContain("the deployment guide");
    const code = within(paragraph).getByText("../deploy.md");
    expect(code.tagName).toBe("CODE");
    expect(code.closest("a")).toBeNull();
  });

  it("does not print a path twice when the link text is the path", () => {
    const { container } = renderChapter(
      fixture({ body: "Read [../deploy.md](../deploy.md) next.\n" }),
    );

    const paragraph = container.querySelector("p") as HTMLElement;
    expect(paragraph.textContent).toBe("Read ../deploy.md next.");
    expect(paragraph.querySelector("code")?.textContent).toBe("../deploy.md");
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not turn a javascript: URL into a link", () => {
    const { container } = renderChapter(
      fixture({ body: "Click [here](javascript:alert(1)) now.\n" }),
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("Click here now.");
  });
});

describe("raw HTML", () => {
  it("is shown as text and never becomes an element", () => {
    const { container } = renderChapter(
      fixture({
        body: 'Before <script>window.hacked = 1</script> <b onclick="x()">bold</b> after.\n\n<img src="/x.png" onerror="y()">\n',
        headings: [],
        screenshots: [],
      }),
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onclick], [onerror]")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });
});

describe("tables", () => {
  it("wraps a table in a focusable, labelled, horizontally scrollable region", () => {
    const { container } = renderChapter();

    const region = screen.getByRole("region", { name: "Table: Term" });
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Table: Term");
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.tabIndex).toBe(0);

    // The region is what scrolls, and it never grows past its container.
    const classes = region.className.split(/\s+/);
    expect(classes).toContain("overflow-x-auto");
    expect(classes).toContain("max-w-full");

    const tables = container.querySelectorAll("table");
    expect(tables).toHaveLength(1);
    expect(tables[0].parentElement).toBe(region);

    expect(within(region).getByRole("columnheader", { name: "Term" }).getAttribute("scope")).toBe(
      "col",
    );
    expect(within(region).getByRole("cell", { name: "A public timestamp" })).toBeTruthy();
  });

  it("names each region after its own table's first header", () => {
    renderChapter(
      fixture({
        body: "| Dimension | What to judge |\n| --- | --- |\n| Novelty | What is new? |\n\n| # | If | Status |\n| --- | --- | --- |\n| 1 | A retraction | **Retracted** |\n",
        headings: [],
        screenshots: [],
      }),
    );

    const regions = screen.getAllByRole("region");
    expect(regions.map((region) => region.getAttribute("aria-label"))).toEqual([
      "Table: Dimension",
      "Table: #",
    ]);
    for (const region of regions) expect(region.tabIndex).toBe(0);
  });

  it("lets the column that holds the table shrink, so a wide table cannot widen the page", () => {
    const { container } = renderChapter();

    // The wrapping element is the one a flex/grid parent measures.
    const root = container.firstElementChild as HTMLElement;
    const classes = root.className.split(/\s+/);
    expect(classes).toContain("min-w-0");
    expect(classes).toContain("max-w-full");
  });
});

describe("screenshots", () => {
  it("shows each screenshot as a figure directly after the heading it names", () => {
    const { container } = renderChapter();

    const heading = screen.getByRole("heading", { level: 2, name: "Where things are" });
    const first = heading.nextElementSibling as HTMLElement;
    const second = first.nextElementSibling as HTMLElement;

    expect(first.tagName).toBe("FIGURE");
    expect(second.tagName).toBe("FIGURE");
    // The chapter's own text follows the figures, not the other way round.
    expect(second.nextElementSibling?.textContent).toBe("The navigation sits at the top.");

    // Each screenshot appears once, and only under the heading it names.
    expect(container.querySelectorAll("figure")).toHaveLength(2);
    expect(
      screen
        .getAllByRole("heading")
        .filter((item) => item.nextElementSibling?.tagName === "FIGURE"),
    ).toEqual([heading]);
  });

  it("gives the image its src, alt, size and lazy, async loading", () => {
    renderChapter();

    const figures = screen.getAllByRole("figure");
    for (const [figure, shot] of [
      [figures[0], SHOT_WIDE],
      [figures[1], SHOT_PHONE],
    ] as const) {
      const image = within(figure).getByRole("img", { name: shot.alt });
      expect(image.getAttribute("src")).toBe(shot.src);
      expect(image.getAttribute("alt")).toBe(shot.alt);
      expect(image.getAttribute("width")).toBe(String(shot.width));
      expect(image.getAttribute("height")).toBe(String(shot.height));
      expect(image.getAttribute("loading")).toBe("lazy");
      expect(image.getAttribute("decoding")).toBe("async");
    }
  });

  it("captions the figure and links to the full-size image", () => {
    renderChapter();

    const [figure] = screen.getAllByRole("figure");
    const caption = figure.querySelector("figcaption") as HTMLElement;
    expect(caption.textContent).toBe(SHOT_WIDE.caption);

    const link = within(figure).getByRole("link", { name: /full-size image/i });
    expect(link.getAttribute("href")).toBe(SHOT_WIDE.src);
    // A static file, so a plain anchor rather than a client-side route change.
    expect(link.hasAttribute("data-next-link")).toBe(false);
    expect(link.contains(within(figure).getByRole("img"))).toBe(true);
    // Names differ per figure, so two links never share a name but not a target.
    const names = screen
      .getAllByRole("link", { name: /full-size image/i })
      .map((item) => item.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
  });

  it("puts a screenshot under a ### heading as well", () => {
    renderChapter(
      fixture({
        screenshots: [{ ...SHOT_WIDE, heading: "Repeat" }],
      }),
    );

    // "Repeat" is both a ### and a ##; the first one in the chapter owns it.
    const heading = screen.getByRole("heading", { level: 3, name: "Repeat" });
    expect(heading.nextElementSibling?.tagName).toBe("FIGURE");
    expect(screen.getAllByRole("figure")).toHaveLength(1);
  });

  it("shows no figure for a chapter with no screenshots", () => {
    renderChapter(fixture({ screenshots: [] }));
    expect(screen.queryAllByRole("figure")).toHaveLength(0);
  });
});

describe("every handbook chapter", () => {
  it("renders with all its headings, screenshots, tables and links in place", () => {
    for (const chapter of chapters) {
      const { container, unmount } = render(<HandbookMarkdown chapter={chapter} />);
      const where = `chapter ${chapter.slug}`;

      // Each ## and ### carries its id, at its level, with a '#' link to it.
      for (const heading of chapter.headings) {
        const element = container.querySelector(`[id="${heading.id}"]`);
        expect(element?.tagName, `${where}: heading #${heading.id}`).toBe(`H${heading.level}`);
        const link = within(element as HTMLElement).getByRole("link", {
          name: SECTION_LINK_LABEL,
        });
        expect(link.getAttribute("href")).toBe(`#${heading.id}`);
      }
      expect(container.querySelectorAll("h2, h3"), where).toHaveLength(chapter.headings.length);

      // Each screenshot follows the heading it names, with its alt and caption.
      // Several screenshots under one heading are a run of figures after it.
      expect(container.querySelectorAll("figure"), where).toHaveLength(chapter.screenshots.length);
      for (const shot of chapter.screenshots) {
        const owner = chapter.headings.find((heading) => heading.text === shot.heading)!;
        const run: HTMLElement[] = [];
        for (
          let next = container.querySelector(`[id="${owner.id}"]`)?.nextElementSibling;
          next?.tagName === "FIGURE";
          next = next.nextElementSibling
        ) {
          run.push(next as HTMLElement);
        }
        const figure = run.find((item) => item.querySelector(`img[src="${shot.src}"]`));
        expect(figure, `${where}: ${shot.src} directly after "${shot.heading}"`).toBeDefined();
        expect(figure?.querySelector("img")?.getAttribute("alt"), `${where}: ${shot.src}`).toBe(
          shot.alt,
        );
        expect(figure?.querySelector("figcaption")?.textContent).toBe(shot.caption);
      }

      // No table can widen the page, and no HTML from the Markdown got through.
      for (const table of Array.from(container.querySelectorAll("table"))) {
        const region = table.parentElement as HTMLElement;
        expect(region.getAttribute("role"), where).toBe("region");
        expect(region.getAttribute("tabindex"), where).toBe("0");
        expect(region.getAttribute("aria-label"), where).toMatch(/^Table: \S/);
      }
      expect(container.querySelector("script, iframe, style"), where).toBeNull();

      // Every internal link is one the docs serve.
      const slugs = new Set(chapters.map((item) => item.slug));
      for (const anchor of Array.from(container.querySelectorAll("a[data-next-link]"))) {
        const href = anchor.getAttribute("href") as string;
        const match = /^\/docs(?:\/([^#]+))?(?:#(.+))?$/.exec(href);
        expect(match, `${where}: ${href}`).not.toBeNull();
        if (match?.[1]) expect(slugs.has(match[1]), `${where}: ${href}`).toBe(true);
      }

      unmount();
    }
  });
});
