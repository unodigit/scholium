// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `next/link` needs the App Router's context. This stand-in is a plain anchor
 * carrying the same `href`, which is all the docs home promises the reader.
 */
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  };
});

import DocsHomePage, {
  dynamic as docsDynamic,
  metadata as docsMetadata,
} from "../../app/(docs)/docs/page";
import {
  DOCS_DESCRIPTION,
  DocsIndex,
  buildDocsSearchIndex,
  chapterVideoLabel,
  formatVideoLength,
} from "./docs-index";
import { chapters, quickStartByRole, type HandbookVideo } from "./handbook";

afterEach(cleanup);

/** The "Chapters" section of the rendered page. */
function chapterSection(): HTMLElement {
  return screen.getByRole("region", { name: "Chapters" });
}

/** The "Start here" section of the rendered page. */
function startHereSection(): HTMLElement {
  return screen.getByRole("region", { name: "Start here" });
}

/** The search field. */
function searchField(): HTMLInputElement {
  return screen.getByLabelText("Search the docs") as HTMLInputElement;
}

/* ---------------------------------------------------------------------------
   The route: metadata and static generation
   ------------------------------------------------------------------------- */

describe("/docs route", () => {
  it("has the metadata title 'Docs' and a description", () => {
    expect(docsMetadata.title).toBe("Docs");
    expect(docsMetadata.description).toBe(DOCS_DESCRIPTION);
    expect(DOCS_DESCRIPTION.length).toBeGreaterThan(0);
  });

  it("is statically generated", () => {
    expect(docsDynamic).toBe("force-static");
  });
});

/* ---------------------------------------------------------------------------
   The page heading
   ------------------------------------------------------------------------- */

describe("docs home heading", () => {
  it("leads with the H1 'Scholium docs' and a sentence on what the docs cover", () => {
    render(<DocsHomePage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Scholium docs" }),
    ).toBeTruthy();
    expect(screen.getByText(DOCS_DESCRIPTION)).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
   Chapter cards
   ------------------------------------------------------------------------- */

describe("chapter cards", () => {
  it("shows one card per chapter, in number order, each linking to its page", () => {
    expect(chapters).toHaveLength(11);

    render(<DocsHomePage />);

    const cards = within(chapterSection()).getAllByRole("listitem");
    expect(cards).toHaveLength(11);

    cards.forEach((card, index) => {
      const chapter = chapters[index];
      expect(card.textContent).toContain(`Chapter ${chapter.number}`);

      const links = within(card).getAllByRole("link");
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute("href")).toBe(chapter.href);
      expect(links[0].textContent).toBe(chapter.title);
      expect(card.textContent).toContain(chapter.summary);
    });

    expect(
      within(chapterSection())
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(chapters.map((chapter) => chapter.href));
  });

  it("gives every card its poster thumbnail, sized and lazy, and its video line", () => {
    render(<DocsHomePage />);

    const cards = within(chapterSection()).getAllByRole("listitem");
    cards.forEach((card, index) => {
      const poster = chapters[index].video?.poster;
      const image = within(card).getByRole("presentation");
      expect(image.getAttribute("src")).toBe(poster?.src ?? "");
      expect(image.getAttribute("width")).toBe(String(poster?.width));
      expect(image.getAttribute("height")).toBe(String(poster?.height));
      expect(image.getAttribute("loading")).toBe("lazy");

      // videos.json has no YouTube address yet, so every card says so.
      expect(card.textContent).toContain("Video coming soon");
    });
  });

  it("reads a card's video line from the duration once a video is set", () => {
    const video: HandbookVideo = {
      youtube: "https://youtu.be/dQw4w9WgXcQ",
      duration_seconds: 273,
      poster: { src: "/docs/posters/ch02-your-account.webp", width: 1280, height: 720 },
      transcript: "transcripts/ch02-your-account.vtt",
    };

    expect(chapterVideoLabel(video)).toBe("Video, 4 min 33 s");
    expect(chapterVideoLabel({ ...video, youtube: "" })).toBe("Video coming soon");
    expect(chapterVideoLabel(null)).toBe("Video coming soon");
    expect(formatVideoLength(300)).toBe("5 min");
    expect(formatVideoLength(45)).toBe("45 s");
  });
});

/* ---------------------------------------------------------------------------
   "Start here" role cards
   ------------------------------------------------------------------------- */

describe("Start here", () => {
  it("shows one card per README role section, in order, with its title and steps", () => {
    expect(quickStartByRole.length).toBeGreaterThan(0);

    render(<DocsHomePage />);

    const section = startHereSection();
    // The outer list holds one <li> per role; each card's steps are the
    // nested ordered list inside it.
    const outerList = within(section).getAllByRole("list")[0];
    const roleCards = Array.from(outerList.children) as HTMLElement[];

    expect(roleCards).toHaveLength(quickStartByRole.length);

    roleCards.forEach((card, index) => {
      const role = quickStartByRole[index];
      expect(
        within(card).getByRole("heading", { level: 3, name: role.title }),
      ).toBeTruthy();
      if (role.steps.length > 0) {
        // Steps are Markdown and render as an ordered list of prose.
        const steps = within(card).getAllByRole("listitem");
        expect(steps).toHaveLength(role.steps.length);
      } else {
        // A role written as a sentence still shows its text.
        expect(card.textContent).toContain("/recover");
      }
    });
  });

  it("renders the steps with the Markdown component, so chapter links are docs links", () => {
    render(<DocsHomePage />);

    const links = within(startHereSection()).getAllByRole("link");
    expect(
      links.some(
        (link) =>
          link.getAttribute("href") ===
          "/docs/your-account#sign-in-with-a-passkey",
      ),
    ).toBe(true);

    // No link still points at a repository file.
    expect(
      links
        .map((link) => link.getAttribute("href") ?? "")
        .filter((href) => href.endsWith(".md")),
    ).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
   Search
   ------------------------------------------------------------------------- */

describe("docs search", () => {
  it("indexes chapter titles, section headings and the chapter 11 glossary terms", () => {
    const index = buildDocsSearchIndex();

    expect(index).toEqual(
      expect.arrayContaining([
        { title: "Your account", href: "/docs/your-account", chapter: "Your account" },
        {
          title: "Sign in with a passkey",
          href: "/docs/your-account#sign-in-with-a-passkey",
          chapter: "Your account",
        },
        { title: "Passkey", href: "/docs/glossary#passkey", chapter: "Glossary" },
        {
          title: "Recovery guardians",
          href: "/docs/your-account#recovery-guardians",
          chapter: "Your account",
        },
      ]),
    );
  });

  it("lists the chapter 2 sign-in section for 'passkey', with the chapter name beside it", () => {
    render(<DocsHomePage />);

    fireEvent.change(searchField(), { target: { value: "passkey" } });

    const signIn = screen.getByRole("link", { name: "Sign in with a passkey" });
    expect(signIn.getAttribute("href")).toBe(
      "/docs/your-account#sign-in-with-a-passkey",
    );
    expect(signIn.closest("li")?.textContent).toContain("Your account");

    // The glossary's own "Passkey" term is found too.
    expect(screen.getByRole("link", { name: "Passkey" }).getAttribute("href")).toBe(
      "/docs/glossary#passkey",
    );
  });

  it("says 'No matches for …' when nothing matches", () => {
    render(<DocsHomePage />);

    fireEvent.change(searchField(), { target: { value: "quasar" } });

    expect(screen.getByText(/No matches for/).textContent).toBe(
      "No matches for “quasar”.",
    );
  });
});

/* ---------------------------------------------------------------------------
   Without JavaScript
   ------------------------------------------------------------------------- */

describe("without JavaScript", () => {
  it("puts every chapter card and link in the first HTML", () => {
    const html = renderToStaticMarkup(<DocsIndex />);

    expect(html).toContain("Scholium docs");
    for (const chapter of chapters) {
      expect(html).toContain(`href="${chapter.href}"`);
      expect(html).toContain(chapter.title);
      expect(html).toContain(chapter.summary);
    }
    for (const role of quickStartByRole) {
      expect(html).toContain(role.title);
    }
  });
});
