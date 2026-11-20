// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseManifest,
  type ManifestData,
  type VersionsData,
} from "../paper-meta/meta";
import type { PaperAuthor, PaperView } from "../search-page/paper";
import { MANIFEST_BODY, SHORT_ID, VERSION_CID } from "./paper-page-fixtures";
import type { PaperPageData, Part } from "./paper-page-data";
import {
  ScholarlyArticleJsonLd,
  absoluteSiteUrl,
  citationDate,
  citationTags,
  creativeWorkStatus,
  paperCanonicalPath,
  paperCitationMetadata,
  scholarlyArticle,
  serializeJsonLd,
  versionListedAt,
} from "./scholarly-metadata";

/**
 * The scholarly metadata a listed paper publishes: Highwire citation tags and
 * one schema.org ScholarlyArticle.
 *
 * These tests pin the facts themselves — the canonical address, the author
 * order, the version's date, the PDF's public URL, the status word and the
 * script-safe JSON — while `paper-route.test.tsx` proves the route attaches
 * them to a listed page and withholds them from every other outcome.
 */

const ALICE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const BOB = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const TITLE = "Can a Meta-Agent Choose the Safer Branch?";
const ABSTRACT =
  "An evaluation framework investigating whether meta-agents can identify the safer of two candidate branches before either is executed.";
const SITE = "https://scholium.example";

function author(overrides: Partial<PaperAuthor> = {}): PaperAuthor {
  return {
    did: ALICE,
    position: 1,
    creditRoles: [],
    name: "Mei Zhang",
    affiliation: "Example University",
    orcid: null,
    ...overrides,
  };
}

const AUTHORS: readonly PaperAuthor[] = [
  author(),
  author({ did: BOB, position: 2, name: "A. Okafor", affiliation: null }),
];

interface Sample {
  version?: number;
  status?: string;
  title?: string;
  abstract?: string;
  licence?: string;
  authors?: readonly PaperAuthor[];
  listedAt?: string | null;
  versions?: Part<VersionsData>;
  manifest?: Part<ManifestData>;
}

/** A listed paper as `loadPaperPageData` would hand it to the route. */
function sample(overrides: Sample = {}): PaperPageData {
  const version = overrides.version ?? 2;
  const listedAt =
    overrides.listedAt === undefined ? "2027-03-02T04:00:00Z" : overrides.listedAt;
  const paper: PaperView = {
    shortId: SHORT_ID,
    paperCid: "bafyrei-genesis",
    versionCid: VERSION_CID,
    n: version,
    title: overrides.title ?? TITLE,
    abstract: overrides.abstract ?? ABSTRACT,
    authors: overrides.authors ?? AUTHORS,
    categories: ["cs.AI", "cs.MA"],
    licence: overrides.licence ?? "CC-BY-4.0",
    status: overrides.status ?? "reviewed",
    notices: [],
  };
  return {
    paper,
    shortId: SHORT_ID,
    version,
    versionId: `${SHORT_ID}/v${version}`,
    totalVersions: version,
    versions: overrides.versions ?? {
      ok: true,
      data: {
        paper: SHORT_ID,
        paperCid: null,
        versions: [
          {
            n: version,
            cid: VERSION_CID,
            changeNote: null,
            listedAt,
            anchor: { status: "pending" },
          },
        ],
      },
    },
    manifest: overrides.manifest ?? {
      ok: true,
      data: parseManifest(MANIFEST_BODY),
    },
    reviews: { ok: false, error: "not read" },
    discussion: { ok: false, error: "not read" },
    reading: { ok: false, error: "not read" },
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
});

describe("the canonical address", () => {
  it("is /p/{id} for the newest-version page", () => {
    expect(paperCanonicalPath(sample(), false)).toBe("/p/6sel-2dio-orm6");
  });

  it("names the version for a version page", () => {
    expect(paperCanonicalPath(sample({ version: 1 }), true)).toBe(
      "/p/6sel-2dio-orm6/v1",
    );
  });

  it("becomes absolute on the deployment's own origin", () => {
    expect(absoluteSiteUrl("/p/6sel-2dio-orm6", SITE)).toBe(
      `${SITE}/p/6sel-2dio-orm6`,
    );
    // A trailing slash on the configured origin does not double up.
    expect(absoluteSiteUrl("/p/6sel-2dio-orm6", `${SITE}/`)).toBe(
      `${SITE}/p/6sel-2dio-orm6`,
    );
  });
});

describe("the version's listed date", () => {
  it("is the shown version's own instant", () => {
    expect(versionListedAt(sample())).toBe("2027-03-02T04:00:00Z");
    expect(versionListedAt(sample({ version: 1, listedAt: "2027-02-01T09:00:00Z" }))).toBe(
      "2027-02-01T09:00:00Z",
    );
  });

  it("is unknown when the timeline could not be read", () => {
    expect(versionListedAt(sample({ versions: { ok: false, error: "boom" } }))).toBeNull();
  });

  it("writes the Highwire form YYYY/MM/DD in UTC", () => {
    expect(citationDate("2027-03-02T04:00:00Z")).toBe("2027/03/02");
    // 23:30 at -05:00 is the next day in UTC, and that is the day published.
    expect(citationDate("2027-03-02T23:30:00-05:00")).toBe("2027/03/03");
    expect(citationDate(null)).toBeNull();
    expect(citationDate("not a date")).toBeNull();
  });
});

describe("the status word", () => {
  it.each([
    ["preprint", "Preprint"],
    ["under_review", "Under review"],
    ["reviewed", "Reviewed"],
    ["corrected", "Corrected"],
    ["retracted", "Retracted"],
  ])("maps %s to %s", (status, word) => {
    expect(creativeWorkStatus(status)).toBe(word);
  });

  it("keeps a contested paper under review rather than inventing a word", () => {
    expect(creativeWorkStatus("contested")).toBe("Under review");
  });

  it("treats an unknown status as a preprint, the API's own default", () => {
    expect(creativeWorkStatus("something-new")).toBe("Preprint");
  });
});

describe("the Highwire citation tags", () => {
  it("publishes the full tag set for a listed paper", () => {
    expect(citationTags(sample())).toMatchObject({
      citation_title: TITLE,
      citation_author: ["Mei Zhang", "A. Okafor"],
      citation_publication_date: "2027/03/02",
      citation_online_date: "2027/03/02",
      citation_abstract: ABSTRACT,
      citation_pdf_url: "http://localhost:8000/v1/content/bafkrei-pdf",
      citation_publisher: "Scholium",
      citation_language: "en",
    });
  });

  it("lists one citation_author per author, in byline order", () => {
    expect(citationTags(sample()).citation_author).toEqual([
      "Mei Zhang",
      "A. Okafor",
    ]);
  });

  it("falls back to the DID when the profile shows no public name", () => {
    const authors = [
      author({ name: null }),
      author({ did: BOB, position: 2, name: "A. Okafor" }),
    ];
    expect(citationTags(sample({ authors })).citation_author).toEqual([
      ALICE,
      "A. Okafor",
    ]);
  });

  it("omits the dates when the timeline could not be read", () => {
    const tags = citationTags(sample({ versions: { ok: false, error: "boom" } }));
    expect(tags.citation_publication_date).toBeUndefined();
    expect(tags.citation_online_date).toBeUndefined();
  });

  it("omits citation_pdf_url when the version has no public PDF", () => {
    const manifest = parseManifest(MANIFEST_BODY);
    const withoutPdf: ManifestData = {
      ...manifest,
      files: manifest.files.filter((file) => file.role !== "manuscript"),
    };
    const tags = citationTags(sample({ manifest: { ok: true, data: withoutPdf } }));
    expect(tags.citation_pdf_url).toBeUndefined();
  });

  it("omits citation_abstract when the version has none", () => {
    expect(citationTags(sample({ abstract: "  " })).citation_abstract).toBeUndefined();
  });

  it("adds the canonical URL and the tags through paperCitationMetadata", () => {
    const meta = paperCitationMetadata(sample(), {
      versionPage: true,
      siteUrl: SITE,
    });
    expect(meta.alternates?.canonical).toBe(`${SITE}/p/6sel-2dio-orm6/v2`);
    expect(meta.other?.citation_title).toBe(TITLE);
  });
});

describe("the ScholarlyArticle JSON-LD", () => {
  it("publishes the article's facts", () => {
    const article = scholarlyArticle(sample(), { versionPage: false, siteUrl: SITE });

    expect(article).toMatchObject({
      "@context": "https://schema.org",
      "@type": "ScholarlyArticle",
      headline: TITLE,
      name: TITLE,
      abstract: ABSTRACT,
      url: `${SITE}/p/6sel-2dio-orm6`,
      license: "CC-BY-4.0",
      isAccessibleForFree: true,
      version: 2,
      datePublished: "2027-03-02T04:00:00Z",
      dateModified: "2027-03-02T04:00:00Z",
      identifier: {
        "@type": "PropertyValue",
        propertyID: "sch",
        value: "sch:6sel-2dio-orm6/v2",
      },
      publisher: { "@type": "Organization", name: "Scholium" },
      creativeWorkStatus: "Reviewed",
    });
  });

  it("lists authors as Person in order, with a public ORCID as sameAs", () => {
    const authors = [
      author({ orcid: "0000-0002-1825-0097" }),
      author({ did: BOB, position: 2, name: "A. Okafor", orcid: null }),
    ];
    const article = scholarlyArticle(sample({ authors }), {
      versionPage: false,
      siteUrl: SITE,
    });

    expect(article.author).toEqual([
      {
        "@type": "Person",
        name: "Mei Zhang",
        sameAs: "https://orcid.org/0000-0002-1825-0097",
      },
      { "@type": "Person", name: "A. Okafor" },
    ]);
  });

  it("uses a version page's canonical address as the article's URL", () => {
    const article = scholarlyArticle(sample({ version: 1 }), {
      versionPage: true,
      siteUrl: SITE,
    });
    expect(article.url).toBe(`${SITE}/p/6sel-2dio-orm6/v1`);
  });

  it("sets creativeWorkStatus to the paper's status word", () => {
    const article = scholarlyArticle(sample({ status: "retracted" }), {
      versionPage: false,
      siteUrl: SITE,
    });
    expect(article.creativeWorkStatus).toBe("Retracted");
  });
});

describe("the JSON is safe inside a script element", () => {
  it("escapes every less-than sign, so a title cannot close the script", () => {
    const title = "</script><script>alert(1)</script> paper";
    const json = serializeJsonLd(
      scholarlyArticle(sample({ title }), { versionPage: false, siteUrl: SITE }),
    );

    expect(json).not.toContain("</script>");
    expect(json).toContain("\\u003c");
    // The escape is still valid JSON, and the title survives it exactly.
    expect(JSON.parse(json).headline).toBe(title);
  });
});

describe("the rendered script element", () => {
  it("is one application/ld+json ScholarlyArticle", () => {
    const html = renderToStaticMarkup(
      createElement(ScholarlyArticleJsonLd, {
        data: sample(),
        versionPage: false,
        siteUrl: SITE,
      }),
    );
    document.body.innerHTML = html;

    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(1);
    const article = JSON.parse(scripts[0].textContent ?? "");
    expect(article["@type"]).toBe("ScholarlyArticle");
    expect(article.url).toBe(`${SITE}/p/6sel-2dio-orm6`);
  });
});
