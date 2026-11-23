// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chapters } from "./handbook";

/* ---------------------------------------------------------------------------
   Next.js plumbing. `usePathname` is read during render, so it is mocked at
   the module level; `pathnameValue` is read lazily (inside the component),
   which keeps the vi.mock factory hoist-safe — the same approach as
   `components/nav/global-nav.test.tsx`. `next/link` renders as a plain
   anchor: the docs pages are server-rendered, and the tests only need the
   destination the reader would get.
   ------------------------------------------------------------------------- */

let pathnameValue: string | null = "/docs";

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameValue,
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children);
  return { default: Link };
});

import { DocsShell } from "./docs-shell";

beforeEach(() => {
  pathnameValue = "/docs";
});

afterEach(cleanup);

/** The chapter list element, once rendered. */
function chapterList(): HTMLOListElement {
  return screen.getByRole("list") as HTMLOListElement;
}

/* ---------------------------------------------------------------------------
   The chapter list
   ------------------------------------------------------------------------- */

describe("DocsShell chapter list", () => {
  it("shows the 11 handbook chapters as links, in number order", () => {
    expect(chapters).toHaveLength(11);

    render(<DocsShell chapters={chapters}>Chapter text</DocsShell>);

    // The list is the <ol> inside the "Chapters" disclosure.
    const list = chapterList();
    expect(list.tagName).toBe("OL");

    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(11);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      chapters.map((chapter) => chapter.href),
    );
    expect(links.map((link) => link.textContent)).toEqual(
      chapters.map((chapter) => chapter.title),
    );

    // A numbered list: one <li> per chapter, in order.
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(11);
    expect(items.map((item) => item.querySelector("a")?.getAttribute("href"))).toEqual(
      chapters.map((chapter) => chapter.href),
    );
  });

  it("marks exactly the current chapter with aria-current", () => {
    pathnameValue = chapters[1].href; // /docs/your-account
    render(<DocsShell chapters={chapters}>Chapter text</DocsShell>);

    const current = chapterList().querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("href")).toBe(chapters[1].href);
    expect(current[0].textContent).toBe(chapters[1].title);
  });

  it("marks no chapter on the docs index", () => {
    pathnameValue = "/docs";
    render(<DocsShell chapters={chapters}>Index text</DocsShell>);

    expect(chapterList().querySelectorAll('[aria-current="page"]')).toHaveLength(
      0,
    );
  });

  it("marks no chapter for a slug that is not a chapter", () => {
    pathnameValue = "/docs/no-such-chapter";
    render(<DocsShell chapters={chapters}>Not found</DocsShell>);

    expect(chapterList().querySelectorAll('[aria-current="page"]')).toHaveLength(
      0,
    );
  });
});

/* ---------------------------------------------------------------------------
   The shell around the list
   ------------------------------------------------------------------------- */

describe("DocsShell shell", () => {
  it("leads with a Docs heading that links back to /docs", () => {
    render(<DocsShell chapters={chapters}>Index text</DocsShell>);

    expect(
      screen.getByRole("heading", { level: 2, name: "Docs" }),
    ).toBeTruthy();

    const home = screen.getByRole("link", { name: "Docs" });
    expect(home.getAttribute("href")).toBe("/docs");
  });

  it("names the chapter navigation after the Docs heading", () => {
    render(<DocsShell chapters={chapters}>Index text</DocsShell>);

    expect(screen.getByRole("navigation", { name: "Docs" })).toBeTruthy();
  });

  it("collapses the chapters into a Chapters disclosure above the content", () => {
    const { container } = render(
      <DocsShell chapters={chapters}>Chapter text</DocsShell>,
    );

    // A native disclosure, rendered open so every chapter link is in the
    // first HTML (no JavaScript needed to read the list).
    const summary = screen
      .getByText("Chapters")
      .closest("summary") as HTMLElement | null;
    expect(summary).not.toBeNull();

    const details = summary?.closest("details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    expect(details?.contains(chapterList())).toBe(true);

    // The disclosure sits above the page content in reading order.
    const content = container.querySelector(".ds-content");
    expect(content).not.toBeNull();
    expect(content?.textContent).toBe("Chapter text");
    expect(
      Boolean(
        (details as Node).compareDocumentPosition(content as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
   The "Chapters" disclosure by window width
   ------------------------------------------------------------------------- */

describe("DocsShell chapters disclosure", () => {
  function stubWidth(wide: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: wide,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts collapsed on a narrow window, so a phone opens on the text", () => {
    stubWidth(false);
    const { container } = render(<DocsShell chapters={chapters}>Chapter text</DocsShell>);
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("stays open as the sidebar on a wide window", () => {
    stubWidth(true);
    const { container } = render(<DocsShell chapters={chapters}>Chapter text</DocsShell>);
    expect(container.querySelector("details")?.open).toBe(true);
  });
});
