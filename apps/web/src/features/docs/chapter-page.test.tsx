// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The chapter page at `/docs/{slug}`.
 *
 * Two layers are checked together:
 *
 * - the route (`app/(docs)/docs/[chapter]/page.tsx`): the 11 statically
 *   generated slugs, `dynamicParams = false`, the "Title · Docs" metadata
 *   with its summary and canonical URL, and the 404 for a slug that is not a
 *   chapter;
 * - the page component (`chapter-page.tsx`): the `Chapter N` eyebrow above
 *   the H1, the summary, every `##` / `###` heading in "On this page", and
 *   previous/next links that exist only between the ends of the handbook.
 *
 * The Markdown body is the server component's job (`markdown.test.tsx`); here
 * it is rendered too, so the article is exercised the way the route composes
 * it, but the assertions below are about the chapter frame.
 */

/* ---------------------------------------------------------------------------
   Next.js plumbing. `notFound` throws Next's 404 control-flow error; the mock
   throws a recognisable one. `next/link` renders a plain anchor, exactly as in
   `docs-shell.test.tsx`.
   ------------------------------------------------------------------------- */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
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

import ChapterRoutePage, {
  dynamicParams,
  generateMetadata,
  generateStaticParams,
} from "../../app/(docs)/docs/[chapter]/page";
import { ChapterPage } from "./chapter-page";
import { chapters, getChapter, type HandbookChapter } from "./handbook";

const here = dirname(fileURLToPath(import.meta.url));

const SITE = "https://scholium.example";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The chapter with this slug; the tests name chapters they know exist. */
function chapterAt(slug: string): HandbookChapter {
  const chapter = getChapter(slug);
  if (chapter === undefined) throw new Error(`no chapter ${slug}`);
  return chapter;
}

/** The chapter before and after `slug`, as the route computes them. */
function neighbours(slug: string): {
  previous: HandbookChapter | null;
  next: HandbookChapter | null;
} {
  const index = chapters.findIndex((chapter) => chapter.slug === slug);
  return {
    previous: index > 0 ? chapters[index - 1] : null,
    next: index < chapters.length - 1 ? chapters[index + 1] : null,
  };
}

function linkProps(chapter: HandbookChapter | null) {
  return chapter === null ? null : { title: chapter.title, href: chapter.href };
}

/** Render the page component for one chapter with the route's own links. */
function renderChapter(slug: string) {
  const chapter = chapterAt(slug);
  const { previous, next } = neighbours(slug);
  return render(
    <ChapterPage
      number={chapter.number}
      title={chapter.title}
      summary={chapter.summary}
      headings={chapter.headings}
      video={chapter.video}
      transcript={[]}
      previous={linkProps(previous)}
      next={linkProps(next)}
    >
      <p>Chapter body</p>
    </ChapterPage>,
  );
}

/** Render the real route page for one chapter. */
async function renderRoute(slug: string) {
  const element = await ChapterRoutePage({
    params: Promise.resolve({ chapter: slug }),
  });
  return render(element);
}

/* ---------------------------------------------------------------------------
   The page frame
   ------------------------------------------------------------------------- */

describe("chapter page", () => {
  it("puts the Chapter N eyebrow above the H1, then the summary", () => {
    const chapter = chapterAt("your-account");
    const { container } = renderChapter("your-account");

    const heading = screen.getByRole("heading", {
      level: 1,
      name: chapter.title,
    });
    const eyebrow = container.querySelector(".chapter-eyebrow");
    expect(eyebrow?.textContent).toBe("Chapter 2");

    // The eyebrow comes first in reading order.
    expect(
      Boolean(
        (eyebrow as Node).compareDocumentPosition(heading) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // The summary sits under the title, before the body.
    const summary = screen.getByText(chapter.summary);
    expect(
      Boolean(
        heading.compareDocumentPosition(summary) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("lists every ## and ### heading in On this page, in document order", () => {
    const chapter = chapterAt("your-account");
    renderChapter("your-account");

    const contents = screen.getByRole("navigation", { name: "On this page" });
    const links = within(contents).getAllByRole("link");

    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      chapter.headings.map((heading) => `#${heading.id}`),
    );
    expect(links.map((link) => link.textContent)).toEqual(
      chapter.headings.map((heading) => heading.text),
    );

    // The chapter's first section is the one the docs home links to.
    expect(
      links.find((link) => link.textContent === "Sign in with a passkey")
        ?.getAttribute("href"),
    ).toBe("#sign-in-with-a-passkey");

    // The list contains exactly the level-2 and level-3 headings.
    expect(links).toHaveLength(
      chapter.headings.filter((heading) => heading.level === 2 || heading.level === 3)
        .length,
    );
  });

  it("shows the chapter video block and the server-rendered body", () => {
    const chapter = chapterAt("your-account");
    const { container } = renderChapter("your-account");

    // The video is present as the click-to-load block, with its poster.
    const video = container.querySelector(".chapter-video");
    expect(video).not.toBeNull();
    expect(video?.querySelector("img")?.getAttribute("src")).toBe(
      chapter.video?.poster.src,
    );

    // The body arrives as children; nothing about it is client-side here.
    expect(screen.getByText("Chapter body")).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
   "On this page" when the chapter is scrolled to its very bottom
   ------------------------------------------------------------------------- */

describe("On this page at the bottom of the chapter", () => {
  /** Redefine a scroll metric jsdom has no layout to compute, restorably. */
  function setMetric(object: object, name: string, value: number) {
    Object.defineProperty(object, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  it("marks the last heading on screen once the page runs out of scroll", () => {
    const chapter = chapterAt("your-account");
    const headingByText = new Map(
      chapter.headings.map((heading) => [heading.text, heading]),
    );
    const last = headingByText.get("Your dashboard");
    const beforeLast = headingByText.get("Erase your profile");
    const earlier = headingByText.get("Security settings");
    if (!last || !beforeLast || !earlier) {
      throw new Error("the chapter's last headings moved");
    }

    // The observer is a stub: it never delivers on its own, so the band's
    // entries are handed to it, entry by entry, below.
    let notify: IntersectionObserverCallback | undefined;
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);

    // A 2000px chapter in an 800px viewport: 1200px of scroll, currently
    // 1000px down, with the last section still below the reading band.
    setMetric(window, "innerHeight", 800);
    setMetric(window, "scrollY", 1000);
    setMetric(document.documentElement, "scrollHeight", 2000);

    render(
      <ChapterPage
        number={chapter.number}
        title={chapter.title}
        summary={chapter.summary}
        headings={chapter.headings}
        video={chapter.video}
        transcript={[]}
        previous={null}
        next={null}
      >
        {chapter.headings.map((heading) => (
          <h2 key={heading.id} id={heading.id}>
            {heading.text}
          </h2>
        ))}
      </ChapterPage>,
    );

    // At the bottom of the chapter every heading has scrolled out above the
    // viewport except the last one, "Your dashboard".
    for (const heading of chapter.headings) {
      const element = document.getElementById(heading.id);
      if (element === null) throw new Error(`no #${heading.id} in the body`);
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
        top: heading.id === last.id ? 250 : -400,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }

    const contents = screen.getByRole("navigation", { name: "On this page" });
    const current = () =>
      within(contents)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "location")
        .map((link) => link.textContent);
    const bandEntry = (
      heading: (typeof chapter.headings)[number],
      isIntersecting: boolean,
    ) =>
      ({
        isIntersecting,
        target: document.getElementById(heading.id),
      }) as unknown as IntersectionObserverEntry;

    // Mid-chapter the reading band alone decides, as before.
    act(() => {
      notify?.([bandEntry(beforeLast, true)], {} as IntersectionObserver);
    });
    expect(current()).toEqual(["Erase your profile"]);

    // Scrolled to the very bottom: the last section never climbs into the
    // band, but it is the one on screen, so it is the one marked.
    setMetric(window, "scrollY", 1200);
    fireEvent.scroll(window);
    expect(current()).toEqual(["Your dashboard"]);

    // Back off the bottom, the band decides again.
    setMetric(window, "scrollY", 1000);
    act(() => {
      notify?.(
        [bandEntry(beforeLast, false), bandEntry(earlier, true)],
        {} as IntersectionObserver,
      );
    });
    expect(current()).toEqual(["Security settings"]);

    // And following a contents link still marks that entry.
    fireEvent.click(
      within(contents).getByRole("link", { name: "Erase your profile" }),
    );
    expect(current()).toEqual(["Erase your profile"]);

    // jsdom's own metrics back for the rest of the file.
    setMetric(window, "scrollY", 0);
    setMetric(window, "innerHeight", 768);
    delete (document.documentElement as { scrollHeight?: number }).scrollHeight;
  });

  it("marks the section being read after a jump straight to the bottom", () => {
    const chapter = chapterAt("your-account");
    const headingByText = new Map(
      chapter.headings.map((heading) => [heading.text, heading]),
    );
    const last = headingByText.get("Your dashboard");
    if (!last) throw new Error("the chapter's last heading moved");

    // The observer is a stub that never delivers: a jump like the End key
    // lands past the band before any entry arrives.
    class FakeObserver {
      constructor(_callback: IntersectionObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);

    // The report's 900px viewport and a chapter long enough that the End
    // key scrolls all the way down in one jump.
    setMetric(window, "innerHeight", 900);
    setMetric(window, "scrollY", 2100);
    setMetric(document.documentElement, "scrollHeight", 3000);

    render(
      <ChapterPage
        number={chapter.number}
        title={chapter.title}
        summary={chapter.summary}
        headings={chapter.headings}
        video={chapter.video}
        transcript={[]}
        previous={null}
        next={null}
      >
        {chapter.headings.map((heading) => (
          <h2 key={heading.id} id={heading.id}>
            {heading.text}
          </h2>
        ))}
      </ChapterPage>,
    );

    // After the jump every heading has scrolled out above the viewport,
    // the last one 447px above the top, as on /docs/your-account.
    for (const heading of chapter.headings) {
      const element = document.getElementById(heading.id);
      if (element === null) throw new Error(`no #${heading.id} in the body`);
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
        top: heading.id === last.id ? -447 : -1200,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }

    const contents = screen.getByRole("navigation", { name: "On this page" });
    const current = () =>
      within(contents)
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "location")
        .map((link) => link.textContent);

    // The jump's own scroll event: the section being read is the chapter's
    // last one, even though its heading sits above the viewport.
    fireEvent.scroll(window);
    expect(current()).toEqual(["Your dashboard"]);

    // jsdom's own metrics back for the rest of the file.
    setMetric(window, "scrollY", 0);
    setMetric(window, "innerHeight", 768);
    delete (document.documentElement as { scrollHeight?: number }).scrollHeight;
  });
});

/* ---------------------------------------------------------------------------
   Previous and next chapter links
   ------------------------------------------------------------------------- */

describe("chapter pager", () => {
  it("links to both neighbours in the middle of the handbook", async () => {
    await renderRoute("your-account");

    const pager = screen.getByRole("navigation", {
      name: "Previous and next chapter",
    });
    const previous = within(pager).getByRole("link", {
      name: /Previous chapter/,
    });
    const next = within(pager).getByRole("link", { name: /Next chapter/ });

    expect(previous.getAttribute("href")).toBe("/docs/how-scholium-works");
    expect(previous.textContent).toContain("How Scholium works");
    expect(next.getAttribute("href")).toBe(
      "/docs/reading-and-finding-papers",
    );
    expect(next.textContent).toContain("Reading and finding papers");
  });

  it("has no previous link before Chapter 1", async () => {
    await renderRoute("how-scholium-works");

    expect(
      screen.queryByRole("link", { name: /Previous chapter/ }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: /Next chapter/ }).getAttribute("href"),
    ).toBe("/docs/your-account");
  });

  it("has no next link after Chapter 11", async () => {
    await renderRoute("glossary");

    expect(screen.queryByRole("link", { name: /Next chapter/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: /Previous chapter/ }).getAttribute(
        "href",
      ),
    ).toBe("/docs/faq-and-known-limitations");
  });
});

/* ---------------------------------------------------------------------------
   The route: static params, metadata and the 404
   ------------------------------------------------------------------------- */

describe("chapter route", () => {
  it("statically generates exactly the 11 chapter slugs", () => {
    expect(dynamicParams).toBe(false);
    expect(chapters).toHaveLength(11);

    const params = generateStaticParams();
    expect(params).toHaveLength(11);
    expect(params.map((entry) => entry.chapter)).toEqual(
      chapters.map((chapter) => chapter.slug),
    );
  });

  it("titles the page with the chapter title and Docs, its summary and canonical URL", async () => {
    const chapter = chapterAt("your-account");
    const metadata = await generateMetadata({
      params: Promise.resolve({ chapter: chapter.slug }),
    });

    // The root template adds " · Scholium", as on the docs home.
    expect(metadata.title).toBe("Your account · Docs");
    expect(metadata.description).toBe(chapter.summary);
    expect(metadata.alternates?.canonical).toBe(`${SITE}/docs/your-account`);
  });

  it("answers 404 for a slug that is not a chapter", async () => {
    await expect(
      ChapterRoutePage({
        params: Promise.resolve({ chapter: "no-such-chapter" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    await expect(
      generateMetadata({
        params: Promise.resolve({ chapter: "no-such-chapter" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

/* ---------------------------------------------------------------------------
   chapter.css: token-only styling
   ------------------------------------------------------------------------- */

describe("chapter.css", () => {
  const css = readFileSync(join(here, "chapter.css"), "utf8");
  const tokensCss = readFileSync(
    join(here, "../../styles/tokens.css"),
    "utf8",
  );
  /** Rules only: the header comment deliberately names tokens and colours. */
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("uses only design tokens for colour", () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch|lab|lch)\(/i);
  });

  it("names only custom properties declared in tokens.css", () => {
    const declared = new Set(
      [...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]),
    );
    const referenced = [
      ...rules.matchAll(/var\(\s*(--[a-z0-9-]+)/gi),
    ].map((match) => match[1]);

    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(declared.has(name), `${name} is not a tokens.css property`).toBe(
        true,
      );
    }
  });
});
