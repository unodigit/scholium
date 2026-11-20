// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { alt as shareCardAlt, size as shareCardSize } from "../../app/opengraph-image";
import { FAQ_ENTRIES } from "./faq";
import {
  HOME_DATE_MODIFIED,
  HOME_DESCRIPTION,
  HOME_FEATURE_LIST,
  HOME_SHARE_IMAGE_ALT,
  HOME_SHARE_IMAGE_SIZE,
  HOME_TITLE,
  absoluteUrl,
  homeJsonLd,
  homeMetadata,
  serializeJsonLd,
  type JsonLdNode,
} from "./structured-data";

/**
 * What the homepage publishes for machines: its metadata and its JSON-LD. The
 * checks are about the contract a crawler relies on (each `@type`, an FAQPage
 * that is the visible FAQ, absolute URLs from `NEXT_PUBLIC_SITE_URL`, JSON that
 * cannot close its script element), and against the reference
 * `docs/homepage/index.html` so the copy cannot drift from it.
 */

const SITE = "https://scholium.example";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const REFERENCE_HTML = readFileSync(here("../../../../../docs/homepage/index.html"), "utf8");

/** The reference's illustrative origin, replaced by the configured site URL. */
const REFERENCE_ORIGIN = "https://scholium.fyi";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("./faq.ts");
  vi.resetModules();
});

type Graph = readonly JsonLdNode[];

/** The node of this `@type` (there is exactly one of each). */
function nodeOf(graph: Graph, type: string): JsonLdNode {
  const matches = graph.filter((node) => node["@type"] === type);
  expect(matches, `exactly one ${type} in the graph`).toHaveLength(1);
  return matches[0]!;
}

/** Every string in a JSON value, with the key path that leads to it. */
function* strings(value: unknown, path = "$"): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* strings(item, `${path}[${index}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) yield* strings(item, `${path}.${key}`);
  }
}

/** The reference's JSON-LD document, parsed. */
function referenceJsonLd(): { "@context": string; "@graph": JsonLdNode[] } {
  const match = REFERENCE_HTML.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  expect(match, "the reference carries a JSON-LD block").not.toBeNull();
  return JSON.parse(match![1]!);
}

/** A `<meta>` or `<title>` value from the reference's head. */
function referenceMeta(selector: RegExp): string {
  const match = REFERENCE_HTML.match(selector);
  expect(match, `the reference has ${selector}`).not.toBeNull();
  return match![1]!;
}

describe("homeJsonLd", () => {
  const graph = homeJsonLd(SITE)["@graph"];

  it("is one schema.org @graph holding the six types, once each", () => {
    expect(homeJsonLd(SITE)["@context"]).toBe("https://schema.org");
    expect(graph.map((node) => node["@type"])).toEqual([
      "Organization",
      "WebSite",
      "WebPage",
      "WebApplication",
      "DefinedTerm",
      "FAQPage",
    ]);
  });

  it("describes the Organization: name, URL and a 512 px logo", () => {
    const organization = nodeOf(graph, "Organization");

    expect(organization.name).toBe("Scholium");
    expect(organization.url).toBe(`${SITE}/`);
    expect(organization.logo).toEqual({
      "@type": "ImageObject",
      url: `${SITE}/brand/icon-512.png`,
      width: 512,
      height: 512,
    });
    expect(typeof organization.description).toBe("string");
    expect(organization.description).not.toBe("");
  });

  it("describes the WebSite: alternate name, language, publisher and a search action", () => {
    const website = nodeOf(graph, "WebSite");
    const organization = nodeOf(graph, "Organization");

    expect(website.name).toBe("Scholium");
    expect(website.alternateName).toBe("Scholium Network");
    expect(website.inLanguage).toBe("en");
    expect(website.publisher).toEqual({ "@id": organization["@id"] });
    expect(website.potentialAction).toEqual({
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        // The placeholder's braces are literal: they are not URL-encoded.
        urlTemplate: `${SITE}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    });
  });

  it("describes the WebPage: part of the site, about the app, with a modification date", () => {
    const page = nodeOf(graph, "WebPage");

    expect(page.isPartOf).toEqual({ "@id": nodeOf(graph, "WebSite")["@id"] });
    expect(page.about).toEqual({ "@id": nodeOf(graph, "WebApplication")["@id"] });
    expect(page.name).toBe(HOME_TITLE);
    expect(page.dateModified).toBe(HOME_DATE_MODIFIED);
    expect(page.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("describes the WebApplication: a free reference application with the feature list", () => {
    const app = nodeOf(graph, "WebApplication");

    expect(app.applicationCategory).toBe("ReferenceApplication");
    expect(app.isAccessibleForFree).toBe(true);
    expect(app.offers).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD" });
    expect(app.publisher).toEqual({ "@id": nodeOf(graph, "Organization")["@id"] });
    expect(app.featureList).toEqual(HOME_FEATURE_LIST);
    expect(HOME_FEATURE_LIST).toHaveLength(13);
  });

  it("defines the term 'scholium'", () => {
    const term = nodeOf(graph, "DefinedTerm");

    expect(term.name).toBe("scholium");
    expect(term.description).toBe(
      "An explanatory note written in the margin of a scholarly text. Plural: scholia.",
    );
  });

  it("builds the FAQPage from faq.ts: its questions and answers are the visible ones, in order", () => {
    const faq = nodeOf(graph, "FAQPage");
    const entries = faq.mainEntity as {
      "@type": string;
      name: string;
      acceptedAnswer: { "@type": string; text: string };
    }[];

    expect(entries).toHaveLength(FAQ_ENTRIES.length);
    expect(
      entries.map((entry) => ({ question: entry.name, answer: entry.acceptedAnswer.text })),
    ).toEqual(FAQ_ENTRIES.map(({ question, answer }) => ({ question, answer })));
    for (const entry of entries) {
      expect(entry["@type"]).toBe("Question");
      expect(entry.acceptedAnswer["@type"]).toBe("Answer");
    }
  });

  it("follows faq.ts when it changes", async () => {
    vi.resetModules();
    vi.doMock("./faq.ts", () => ({
      FAQ_ENTRIES: [{ question: "Is this the only one?", answer: "Yes, for this test." }],
    }));
    const { homeJsonLd: rebuilt } = await import("./structured-data");

    const faq = nodeOf(rebuilt(SITE)["@graph"], "FAQPage");
    expect(faq.mainEntity).toEqual([
      {
        "@type": "Question",
        name: "Is this the only one?",
        acceptedAnswer: { "@type": "Answer", text: "Yes, for this test." },
      },
    ]);
  });

  it("links its nodes: every @id reference points at a node in the graph", () => {
    const ids = new Set(graph.map((node) => node["@id"]));
    const references: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === "@id") {
          references.push((value as { "@id": string })["@id"]);
        } else {
          Object.values(value).forEach(walk);
        }
      }
    };
    graph.forEach(walk);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(ids.has(reference), reference).toBe(true);
    expect(ids.size).toBe(graph.length);
  });

  it("is the reference's graph, with the site's own origin and the site's share card", () => {
    const reference = referenceJsonLd();
    // The reference's illustrative `og.png` is replaced by the card the site
    // actually serves, `/opengraph-image`.
    const expected = JSON.parse(
      JSON.stringify(reference["@graph"])
        .replaceAll(`${REFERENCE_ORIGIN}/og.png`, `${SITE}/opengraph-image`)
        .replaceAll(REFERENCE_ORIGIN, SITE),
    ) as JsonLdNode[];

    expect(graph).toEqual(expected);
  });
});

describe("every URL comes from NEXT_PUBLIC_SITE_URL", () => {
  /** The schema.org vocabulary IRI is not a page of this site. */
  const VOCABULARY = "https://schema.org";

  it("starts every URL in the graph with the configured origin", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.org");

    const document = homeJsonLd();
    const urls = [...strings(document["@graph"])].filter(([, value]) => /^https?:\/\//.test(value));

    expect(urls.length).toBeGreaterThan(10);
    for (const [path, value] of urls) {
      expect(value.startsWith("https://staging.example.org/"), `${path}: ${value}`).toBe(true);
    }
    expect(document["@context"]).toBe(VOCABULARY);
    expect(JSON.stringify(document["@graph"])).not.toContain("scholium.fyi");
  });

  it("does not double the slash when the configured origin ends with one", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.org/");

    const json = JSON.stringify(homeJsonLd());

    expect(json).toContain('"https://staging.example.org/#organization"');
    expect(json).not.toMatch(/https:\/\/staging\.example\.org\/\//);
  });

  it("sets the canonical, the cards and the alternate link from it", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.org");

    const metadata = homeMetadata();

    expect(metadata.alternates?.canonical).toBe("https://staging.example.org/");
    expect(metadata.openGraph?.url).toBe("https://staging.example.org/");
    const images = metadata.openGraph?.images as { url: string }[];
    expect(images.map((image) => image.url)).toEqual(["https://staging.example.org/opengraph-image"]);
    const twitterImages = metadata.twitter?.images as { url: string }[];
    expect(twitterImages.map((image) => image.url)).toEqual([
      "https://staging.example.org/opengraph-image",
    ]);
    expect(metadata.alternates?.types).toEqual({
      "text/markdown": [
        {
          url: "https://staging.example.org/llms.txt",
          title: "Scholium summary for language models",
        },
      ],
    });
  });

  it("hard-codes no domain in the homepage's route files or its feature", () => {
    const feature = here(".");
    const routeGroup = here("../../app/(home)");
    const files = [
      ...readdirSync(feature).map((name) => join(feature, name)),
      ...readdirSync(routeGroup).map((name) => join(routeGroup, name)),
    ].filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\./.test(file));

    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/scholium\.(fyi|io|org|app|com|net)/i);
    }
  });
});

describe("absoluteUrl", () => {
  it("joins a root-relative path to the origin", () => {
    expect(absoluteUrl("/", SITE)).toBe(`${SITE}/`);
    expect(absoluteUrl("/search", SITE)).toBe(`${SITE}/search`);
    expect(absoluteUrl("search", SITE)).toBe(`${SITE}/search`);
    expect(absoluteUrl("/", `${SITE}///`)).toBe(`${SITE}/`);
  });

  it("defaults to the configured site URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://staging.example.org");

    expect(absoluteUrl("/papers")).toBe("https://staging.example.org/papers");
  });
});

describe("serializeJsonLd", () => {
  it("escapes every less-than sign, so no string can close the script element", () => {
    const hostile = {
      "@type": "Question",
      name: "Does </script><script>alert(1)</script> close it? <!-- <b>",
      nested: ["<", { deeper: "a < b << c" }],
    };

    const text = serializeJsonLd(hostile);

    expect(text).not.toContain("<");
    expect(text).toContain("\\u003c/script>");
    expect(text.match(/\\u003c/g)).toHaveLength(9);
    // The escape is JSON's own, so it reads back as the original value.
    expect(JSON.parse(text)).toEqual(hostile);
  });

  it("leaves a document without a less-than sign as plain JSON", () => {
    const value = { a: 1, b: ["x", true, null] };

    expect(serializeJsonLd(value)).toBe(JSON.stringify(value));
  });

  it("serialises the homepage graph with no less-than sign at all", () => {
    expect(serializeJsonLd(homeJsonLd(SITE))).not.toContain("<");
  });
});

describe("homeMetadata", () => {
  const metadata = homeMetadata(SITE);

  it("sets the absolute title, so the '%s · Scholium' template is not applied", () => {
    expect(metadata.title).toEqual({ absolute: "Scholium — signed, open preprints and peer review" });
    expect(HOME_TITLE).toBe(referenceMeta(/<title>([^<]*)<\/title>/));
  });

  it("uses the reference's description", () => {
    expect(metadata.description).toBe(HOME_DESCRIPTION);
    expect(HOME_DESCRIPTION).toBe(referenceMeta(/<meta name="description" content="([^"]*)">/));
  });

  it("sets a canonical URL for the home page", () => {
    expect(metadata.alternates?.canonical).toBe(`${SITE}/`);
  });

  it("sets an Open Graph website card that uses the existing /opengraph-image", () => {
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "Scholium",
      url: `${SITE}/`,
      title: HOME_TITLE,
      description: referenceMeta(/<meta property="og:description" content="([^"]*)">/),
      images: [
        {
          url: `${SITE}/opengraph-image`,
          width: 1200,
          height: 630,
          alt: "scholium: Signed, open preprints and peer review",
        },
      ],
    });
  });

  it("sets a Twitter summary_large_image card that uses the same image", () => {
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: HOME_TITLE,
      description: referenceMeta(/<meta name="twitter:description" content="([^"]*)">/),
      images: [{ url: `${SITE}/opengraph-image` }],
    });
  });

  it("describes the card the existing /opengraph-image route serves", () => {
    expect(HOME_SHARE_IMAGE_ALT).toBe(shareCardAlt);
    expect(HOME_SHARE_IMAGE_SIZE).toEqual(shareCardSize);
  });

  it("lets search and answer engines quote the page in full", () => {
    expect(metadata.robots).toEqual({
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    });
  });
});
