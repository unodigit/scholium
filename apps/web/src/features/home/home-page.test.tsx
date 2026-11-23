import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Children, createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import HomeLayout from "../../app/(home)/layout";
import HomeRoutePage, { dynamic } from "../../app/(home)/page";
import { FAQ_ENTRIES } from "./faq";
import { HomeNav } from "./home-nav";
import { HomePage } from "./home-page";
import * as home from "./index";

/**
 * The homepage as it is assembled: the sections in the reference's order, the
 * `(home)` layout that arms the animations and mounts the home bar, and the
 * route page that adds the one JSON-LD block. The sections have tests of their
 * own; these check how they fit together.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("./faq.ts");
  vi.resetModules();
  document.documentElement.removeAttribute("data-home-js");
});

/** What identifies a section: its anchor, else the heading or label it carries. */
function sectionKey(section: Element): string {
  return (
    section.id ||
    section.getAttribute("aria-labelledby") ||
    section.getAttribute("aria-label") ||
    "(unnamed)"
  );
}

/** The reference's order (docs/homepage/index.html, docs/design.md §5.9). */
const SECTIONS_IN_ORDER = [
  ["Hero", "top"],
  ["Facts strip", "Scholium at a glance"],
  ["Why Scholium", "why-title"],
  ["Provenance", "signed"],
  ["Open review", "review"],
  ["AI pre-review", "ai"],
  ["Verify", "verify"],
  ["Who it's for", "who"],
  ["How it works", "how"],
  ["Compare", "compare"],
  ["Principles", "principles"],
  ["Name", "name"],
  ["FAQ", "faq"],
  ["Final call to action", "final-title"],
] as const;

/** Text with its whitespace runs collapsed, as a reader sees it. */
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Every run of text in the reference's `<main>` (docs/homepage/index.html):
 * its copy, without the scripts, styles and SVG paths that are not words.
 */
function referenceText(): string[] {
  // The module URL as a string: jsdom's global `URL` is not Node's, and
  // `fileURLToPath` would refuse an object made from it.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "../../../../../docs/homepage/index.html"), "utf8");
  const main = source.slice(source.indexOf("<main"), source.indexOf("</main>"));
  const document_ = new DOMParser().parseFromString(main, "text/html");
  document_.querySelectorAll("script, style, svg, symbol").forEach((node) => node.remove());
  const walker = document_.createTreeWalker(document_.body, NodeFilter.SHOW_TEXT);
  const runs: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = collapse(node.textContent ?? "");
    if (text.length > 2) runs.push(text);
  }
  return runs;
}

/** The script element that carries the JSON-LD, read from markup. */
function jsonLdScripts(markup: string): string[] {
  return [...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => match[1]!,
  );
}

describe("HomePage", () => {
  it("renders the fourteen sections in the reference's order", () => {
    const { container } = render(<HomePage />);

    const sections = [...container.querySelectorAll("section")];

    expect(sections.map(sectionKey)).toEqual(SECTIONS_IN_ORDER.map(([, key]) => key));
    // All of them sit at the top level of the page, none nested in another.
    expect(container.querySelectorAll(":scope > section")).toHaveLength(SECTIONS_IN_ORDER.length);
  });

  it("has every word of the reference's copy in its server-rendered HTML, the statement included", () => {
    // `renderToStaticMarkup` is what the server sends: no effect has run, so
    // nothing here depends on JavaScript.
    const served = new DOMParser().parseFromString(
      `<body>${renderToStaticMarkup(<HomePage />)}</body>`,
      "text/html",
    );
    const text = collapse(served.body.textContent ?? "");

    const reference = referenceText();
    expect(reference.length).toBeGreaterThan(300);
    expect(reference.filter((run) => !text.includes(run))).toEqual([]);
    expect(text).toContain("Today, the scientific record lives in someone's database.");
  });

  it("releases the hero's entrance one frame after it mounts, and not before", async () => {
    // The server's HTML has no `play`: with scripts off nothing waits for it.
    expect(renderToStaticMarkup(<HomePage />)).toContain('<section class="hero" id="top"');

    const { container } = render(<HomePage />);
    const hero = container.querySelector("#top")!;

    // Under html[data-home-js] the hero's pieces start hidden and `.play` is
    // what releases them; without it the whole hero would stay blank.
    await waitFor(() => expect(hero.classList.contains("play")).toBe(true));
  });

  it("hands every block the page reveals on scroll to the shared observer", async () => {
    const observed = new Set<Element>();
    class FakeObserver {
      observe(element: Element) {
        observed.add(element);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    vi.resetModules();
    const { HomePage: Fresh } = await import("./home-page");
    const { REVEAL_SELECTOR } = await import("./reveal-scan");

    const { container } = render(<Fresh />);

    // Under html[data-home-js] these blocks start hidden and only the observer
    // reveals them, so one that nobody registered would stay hidden for good.
    const blocks = [...container.querySelectorAll(REVEAL_SELECTOR)];
    expect(blocks.length).toBeGreaterThan(30);
    const missed = blocks.filter((block) => !observed.has(block));
    expect(missed.map((block) => `${block.closest("section")?.id}.${block.className}`)).toEqual([]);
  });

  it("has one h1: the three headline lines", () => {
    const { container } = render(<HomePage />);

    const headings = container.querySelectorAll("h1");

    expect(headings).toHaveLength(1);
    expect([...headings[0]!.querySelectorAll(".line")].map((line) => line.textContent)).toEqual([
      "The preprint, signed.",
      "The review, open.",
      "The record, kept.",
    ]);
  });

  it("carries every anchor the navigation bar links to", () => {
    const { container } = render(<HomePage />);
    const anchors = ["top", "signed", "review", "ai", "verify", "faq"];

    for (const anchor of anchors) {
      expect(container.querySelector(`#${anchor}`), `#${anchor}`).not.toBeNull();
    }
  });

  it("shows exactly the questions and answers in faq.ts", () => {
    const { container } = render(<HomePage />);

    const visible = [...container.querySelectorAll("#faq .faq details")].map((entry) => ({
      question: entry.querySelector("summary h3")?.textContent,
      answer: entry.querySelector(".ans p")?.textContent,
    }));

    expect(visible).toEqual(FAQ_ENTRIES.map(({ question, answer }) => ({ question, answer })));
  });

  it("brings no landmark of its own: the layout owns the bar and main, the root layout the footer", () => {
    const { container } = render(<HomePage />);

    expect(container.querySelector("main")).toBeNull();
    expect(container.querySelector("footer")).toBeNull();
    expect(container.querySelector("#nav")).toBeNull();
  });

  it("uses no raster image and no external stylesheet or font", () => {
    const { container } = render(<HomePage />);

    expect(container.querySelectorAll("img, picture, video, link, iframe")).toHaveLength(0);
  });

  it("is exported, with every section, from the feature's index", () => {
    for (const name of [
      "HomePage",
      "HomeNav",
      "Hero",
      "FactsStrip",
      "Statement",
      "ProvenanceSection",
      "OpenReviewSection",
      "AiPrereviewSection",
      "VerifyBand",
      "RolesSection",
      "HowItWorksSection",
      "CompareSection",
      "PrinciplesSection",
      "NameSection",
      "FaqSection",
      "FinalCta",
    ] as const) {
      expect(typeof home[name], name).toBe("function");
    }
    expect(home.FAQ_ENTRIES).toBe(FAQ_ENTRIES);
    expect(typeof home.homeJsonLd).toBe("function");
    expect(typeof home.homeMetadata).toBe("function");
    expect(typeof home.serializeJsonLd).toBe("function");
  });
});

describe("HomeNav", () => {
  /** Every link in the sections bar, in the order a reader tabs through them. */
  const sectionLinks = (container: HTMLElement): HTMLAnchorElement[] => [
    ...container.querySelectorAll<HTMLAnchorElement>(".nav-links a"),
  ];

  it.each([
    ["signed in", true],
    ["signed out", false],
  ] as const)("links to the docs after FAQ when %s", (_state, signedIn) => {
    const { container } = render(<HomeNav signedIn={signedIn} />);

    const links = sectionLinks(container);

    // The Docs entry is the FAQ section's neighbour: same list, right after it.
    expect(links.map((link) => link.textContent)).toEqual([
      "Provenance",
      "Open review",
      "AI pre-review",
      "Verify",
      "FAQ",
      "Docs",
    ]);
    const docs = links[links.length - 1]!;
    expect(docs.textContent).toBe("Docs");
    expect(docs.getAttribute("href")).toBe("/docs");
  });
});

describe("RevealScan", () => {
  it("observes the blocks a section only wrote class names for, and marks them when seen", async () => {
    const observed: Element[] = [];
    let notify!: IntersectionObserverCallback;
    class FakeObserver {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    vi.resetModules();
    const { RevealScan } = await import("./reveal-scan");

    const { container } = render(
      <main>
        <div id="plain" className="reveal" />
        <div id="rubric" className="rubric" />
        <div id="shown" className="reveal in" />
        <p id="other" />
        <RevealScan />
      </main>,
    );

    // Blocks already shown, and elements that are not reveal blocks, are left alone.
    expect(observed.map((element) => element.id)).toEqual(["plain", "rubric"]);
    act(() => {
      notify(
        [{ isIntersecting: true, target: observed[0]! } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(container.querySelector("#plain")!.classList.contains("in")).toBe(true);
    expect(container.querySelector("#rubric")!.classList.contains("in")).toBe(false);
  });

  it("renders nothing", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.resetModules();
    const { RevealScan } = await import("./reveal-scan");

    const { container } = render(<RevealScan />);

    expect(container.innerHTML).toBe("");
  });
});

describe("the (home) layout", () => {
  const layout = (children: ReactNode = createElement("p", null, "page")) =>
    HomeLayout({ children }) as ReactElement<{ children: ReactNode }>;

  it("starts with the inline script, then the home bar, then the main landmark holding the page", () => {
    const [first, second, third] = Children.toArray(layout().props.children) as ReactElement<{
      id?: string;
      children?: ReactNode;
      dangerouslySetInnerHTML?: { __html: string };
    }>[];

    expect(first?.type).toBe("script");
    expect(first?.props.dangerouslySetInnerHTML?.__html).toContain("data-home-js");
    expect(second?.type).toBe(HomeNav);
    expect(third?.type).toBe("main");
    expect(third?.props.id).toBe("main");
    expect(renderToStaticMarkup(third as ReactElement)).toContain("<p>page</p>");
  });

  it("puts the script first in the rendered HTML, before anything is painted", () => {
    const markup = renderToStaticMarkup(layout());

    expect(markup.startsWith("<script>")).toBe(true);
    expect(markup.indexOf("<script>")).toBeLessThan(markup.indexOf("<header"));
  });

  it("sets data-home-js on <html> when the script runs", () => {
    const [script] = Children.toArray(layout().props.children) as ReactElement<{
      dangerouslySetInnerHTML: { __html: string };
    }>[];
    expect(document.documentElement.hasAttribute("data-home-js")).toBe(false);

    new Function(script!.props.dangerouslySetInnerHTML.__html)();

    expect(document.documentElement.hasAttribute("data-home-js")).toBe(true);
  });

  it("mounts the home bar, not the global navigation or the mobile tab bar", () => {
    const markup = renderToStaticMarkup(layout());

    expect(markup).toContain('class="nav" id="nav"');
    expect(markup).toContain("nav-links");
    expect(markup).not.toContain("gn-"); // GlobalNav and its tab bar spacer
    expect(markup).not.toContain('aria-label="Primary"');
    expect(markup).not.toContain("gn-tabbar-spacer");
  });
});

describe("the (home) route page", () => {
  it("is prerendered: it is forced static, so it reads no request", () => {
    expect(dynamic).toBe("force-static");
  });

  it("renders the homepage and exactly one application/ld+json script", () => {
    const markup = renderToStaticMarkup(createElement(HomeRoutePage));

    expect(jsonLdScripts(markup)).toHaveLength(1);
    expect(markup.match(/application\/ld\+json/g)).toHaveLength(1);
    expect(markup).toContain('id="hero-title"');
    expect(markup).toContain('id="faq"');
  });

  it("publishes a graph that parses, with each type, and an FAQPage equal to the visible FAQ", () => {
    const { container } = render(createElement(HomeRoutePage));

    const script = container.querySelectorAll('script[type="application/ld+json"]');
    expect(script).toHaveLength(1);
    const document_ = JSON.parse(script[0]!.textContent ?? "") as {
      "@context": string;
      "@graph": { "@type": string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] }[];
    };

    expect(document_["@context"]).toBe("https://schema.org");
    expect(document_["@graph"].map((node) => node["@type"])).toEqual([
      "Organization",
      "WebSite",
      "WebPage",
      "WebApplication",
      "DefinedTerm",
      "FAQPage",
    ]);
    const published = document_["@graph"]
      .find((node) => node["@type"] === "FAQPage")!
      .mainEntity!.map((entry) => ({ question: entry.name, answer: entry.acceptedAnswer.text }));
    const visible = [...container.querySelectorAll("#faq .faq details")].map((entry) => ({
      question: entry.querySelector("summary h3")?.textContent,
      answer: entry.querySelector(".ans p")?.textContent,
    }));
    expect(published).toEqual(visible);
    expect(published).toEqual(FAQ_ENTRIES.map(({ question, answer }) => ({ question, answer })));
  });

  it("builds every URL in the page's JSON-LD from NEXT_PUBLIC_SITE_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.org");
    vi.resetModules();
    const { default: Page, metadata } = await import("../../app/(home)/page");

    const [json] = jsonLdScripts(renderToStaticMarkup(createElement(Page)));
    const urls = [...JSON.stringify(JSON.parse(json!)["@graph"]).matchAll(/"(https?:\/\/[^"]+)"/g)].map(
      (match) => match[1]!,
    );

    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) expect(url.startsWith("https://staging.example.org/"), url).toBe(true);
    expect(metadata.alternates?.canonical).toBe("https://staging.example.org/");
  });

  it("exports the absolute title, the description, the canonical and the cards as metadata", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.org");
    vi.resetModules();
    const { metadata } = await import("../../app/(home)/page");

    expect(metadata.title).toEqual({ absolute: "Scholium — signed, open preprints and peer review" });
    expect(metadata.description).toBe(
      "Scholium is a free preprint and peer-review network. Every paper, version and review is signed by its author, reviewed in the open beside the text, and verifiable offline by anyone.",
    );
    expect(metadata.alternates?.canonical).toBe("https://staging.example.org/");
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({ url: "https://staging.example.org/opengraph-image" }),
    ]);
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("escapes a less-than sign in any string, so no string can close the script element", async () => {
    const hostile = {
      question: "Can </script><script>alert(1)</script> end it?",
      answer: "No: a < b, and <b>markup</b> stays text.",
    };
    vi.resetModules();
    vi.doMock("./faq.ts", () => ({ FAQ_ENTRIES: [hostile] }));
    const { default: Page } = await import("../../app/(home)/page");

    const markup = renderToStaticMarkup(createElement(Page));

    const scripts = jsonLdScripts(markup);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toContain("<");
    expect(scripts[0]).toContain("\\u003c/script>");
    const faq = JSON.parse(scripts[0]!)["@graph"].find(
      (node: { "@type": string }) => node["@type"] === "FAQPage",
    );
    expect(faq.mainEntity[0].name).toBe(hostile.question);
    expect(faq.mainEntity[0].acceptedAnswer.text).toBe(hostile.answer);
    // The raw document has no second script from the injected text.
    expect(markup.match(/<script type="application\/ld\+json">/g)).toHaveLength(1);
  });
});
