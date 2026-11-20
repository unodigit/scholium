/**
 * What a listed paper page publishes for machines: Highwire Press citation
 * tags for a search engine's metadata reader, and one schema.org
 * `ScholarlyArticle` in JSON-LD.
 *
 * Search engines and answer engines identify a paper from a small, boring set
 * of facts: its title, its authors in byline order, when the version was
 * listed, its abstract, its PDF, its licence and its identifier. The Highwire
 * tags in `<head>` are what Google Scholar and most indexers read; the
 * JSON-LD is what schema.org consumers and answer engines read. Both are
 * derived here from the same {@link PaperPageData} the page renders, so the
 * answer cannot say something the page does not.
 *
 * The rules the callers rely on:
 *
 * - **A listed paper only.** The route calls these functions on a successful
 *   read only; an unlisted, held, tombstoned or unavailable paper emits no
 *   tags and no JSON-LD, and keeps `robots: { index: false }`
 *   (`paper-route.tsx`).
 * - **Absolute URLs.** A site URL is built from {@link resolveSiteUrl}, never
 *   a hard-coded domain. The PDF is the one exception: its bytes live on the
 *   node, so its absolute URL comes from the manifest (`pdfAccess`).
 * - **Script-safe JSON.** Every `<` in the serialised JSON is escaped as a
 *   Unicode escape, so a title can never close the `<script>` element.
 * - **The version in the address.** `/p/{id}` is canonical for the
 *   newest-version page; `/p/{id}/v{n}` is canonical for a version page.
 *
 * Pure data and functions, server-safe: the route is a server component and
 * the JSON-LD component is rendered in that first HTML response.
 */

import type { Metadata } from "next";
import { createElement, type ReactElement } from "react";

import { resolveSiteUrl } from "../../app/site-metadata";
import type { PaperAuthor } from "../search-page/paper";
import { toDate } from "../ui-kit/format-date";
import { pdfAccess } from "./paper-facts";
import type { PaperPageData } from "./paper-page-data";

/** The publisher of every paper on this node. */
export const CITATION_PUBLISHER = "Scholium";

/** The language the product writes in (docs/design.md). */
export const CITATION_LANGUAGE = "en";

/** The `@type` of the JSON-LD record a paper page publishes. */
export const SCHOLARLY_ARTICLE_TYPE = "ScholarlyArticle";

/** Which page the metadata describes. */
export interface PaperMetadataOptions {
  /**
   * The URL names one version (`/p/{id}/v{n}`) rather than the paper's
   * newest listed version (`/p/{id}`). It decides the canonical URL.
   */
  readonly versionPage: boolean;
  /** The site origin; defaults to {@link resolveSiteUrl}. */
  readonly siteUrl?: string;
}

/* -------------------------------------------------------------------------- */
/* Addresses                                                                   */
/* -------------------------------------------------------------------------- */

/** The short id without its prefix, the way paper URLs write it. */
export function barePaperId(shortId: string): string {
  return shortId.trim().replace(/^sch:/i, "");
}

/**
 * The canonical path of the page: `/p/{id}` for the newest-version page and
 * `/p/{id}/v{n}` for a version page. The `sch:` prefix is dropped, matching
 * every link the product writes (docs/design.md §4).
 */
export function paperCanonicalPath(
  data: Pick<PaperPageData, "shortId" | "version">,
  versionPage: boolean,
): string {
  const id = encodeURIComponent(barePaperId(data.shortId));
  return versionPage ? `/p/${id}/v${data.version}` : `/p/${id}`;
}

/** A site path as an absolute URL on this deployment. */
export function absoluteSiteUrl(path: string, siteUrl?: string): string {
  const base = (siteUrl ?? resolveSiteUrl()).trim().replace(/\/+$/, "");
  return new URL(path, `${base}/`).href;
}

/* -------------------------------------------------------------------------- */
/* Dates and statuses                                                          */
/* -------------------------------------------------------------------------- */

/**
 * When the version on screen was listed (an ISO 8601 instant), or `null` when
 * the timeline could not be read or does not name that version.
 */
export function versionListedAt(
  data: Pick<PaperPageData, "version" | "versions">,
): string | null {
  if (!data.versions.ok) {
    return null;
  }
  const entry = data.versions.data.versions.find(
    (version) => version.n === data.version,
  );
  return entry?.listedAt ?? null;
}

/**
 * The Highwire form of a listed date: `YYYY/MM/DD`.
 *
 * The date is the one UTC saw, so every reader and crawler is told the same
 * day whatever the server's zone. `null` for a missing or unreadable instant.
 */
export function citationDate(listedAt: string | null): string | null {
  const date = listedAt === null ? null : toDate(listedAt);
  if (date === null) {
    return null;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

/**
 * The paper's status as a schema.org `creativeWorkStatus` word.
 *
 * The five words a listing can publish are Preprint, Under review, Reviewed,
 * Corrected and Retracted. A `contested` paper is still under review — a
 * reviewer recommends rejection or a version holds a moderation hold — so it
 * reads "Under review" rather than inventing a sixth word. An unrecognised
 * status is as unknown as nothing having happened, which the API's own
 * default calls `preprint`.
 */
const CREATIVE_WORK_STATUSES: Readonly<Record<string, string>> = {
  preprint: "Preprint",
  under_review: "Under review",
  reviewed: "Reviewed",
  contested: "Under review",
  corrected: "Corrected",
  retracted: "Retracted",
};

export function creativeWorkStatus(status: string): string {
  const key = status.trim().toLowerCase();
  return CREATIVE_WORK_STATUSES[key] ?? CREATIVE_WORK_STATUSES.preprint;
}

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An author's machine-readable name: the profile name people recognise, or
 * the DID when no public name is shown. The DID is the page's own fallback
 * (`authorLabel`), so the citation never names someone the page does not.
 */
export function citationAuthorName(
  author: Pick<PaperAuthor, "did" | "name">,
): string {
  const name = author.name?.trim() ?? "";
  return name !== "" ? name : author.did.trim();
}

/** The public ORCID record of an iD: `https://orcid.org/0000-…`. */
export function orcidSameAs(orcid: string): string {
  const value = orcid.trim();
  return /^https?:\/\//i.test(value)
    ? value
    : `https://orcid.org/${encodeURIComponent(value)}`;
}

/** One author as a schema.org Person, with `sameAs` only when public. */
function personOf(author: PaperAuthor): Record<string, unknown> {
  const person: Record<string, unknown> = {
    "@type": "Person",
    name: citationAuthorName(author),
  };
  const orcid = author.orcid?.trim() ?? "";
  if (orcid !== "") {
    person.sameAs = orcidSameAs(orcid);
  }
  return person;
}

/* -------------------------------------------------------------------------- */
/* Highwire citation tags                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The Highwire Press tags a listed paper publishes through `Metadata.other`.
 *
 * Every tag is conditional on having the fact: no date when the timeline
 * could not be read, no abstract when the version has none, and no
 * `citation_pdf_url` unless the node actually serves the PDF (a PDF still
 * being scanned is not public yet).
 */
export function citationTags(
  data: Pick<PaperPageData, "paper" | "version" | "versions" | "manifest">,
): Record<string, string | string[]> {
  const tags: Record<string, string | string[]> = {
    citation_title: data.paper.title,
    citation_publisher: CITATION_PUBLISHER,
    citation_language: CITATION_LANGUAGE,
  };

  if (data.paper.authors.length > 0) {
    tags.citation_author = data.paper.authors.map(citationAuthorName);
  }

  const listed = citationDate(versionListedAt(data));
  if (listed !== null) {
    tags.citation_publication_date = listed;
    tags.citation_online_date = listed;
  }

  const abstract = data.paper.abstract.trim();
  if (abstract !== "") {
    tags.citation_abstract = abstract;
  }

  const pdf = pdfAccess(data.manifest.ok ? data.manifest.data : undefined);
  if (pdf.kind === "available") {
    tags.citation_pdf_url = pdf.url;
  }

  return tags;
}

/**
 * The metadata a listed paper adds: its canonical URL and its citation tags.
 * Nothing else on the page's metadata changes.
 */
export function paperCitationMetadata(
  data: PaperPageData,
  options: PaperMetadataOptions,
): Pick<Metadata, "alternates" | "other"> {
  return {
    alternates: {
      canonical: absoluteSiteUrl(
        paperCanonicalPath(data, options.versionPage),
        options.siteUrl,
      ),
    },
    other: citationTags(data),
  };
}

/* -------------------------------------------------------------------------- */
/* JSON-LD                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The page's one schema.org `ScholarlyArticle`, as plain JSON-able data.
 *
 * `identifier` is the version's `sch:` id (the thing the version actually is),
 * and `url` is the page's canonical address. A missing abstract, date or
 * licence is left out rather than published as an empty claim.
 */
export function scholarlyArticle(
  data: PaperPageData,
  options: PaperMetadataOptions,
): Record<string, unknown> {
  const article: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": SCHOLARLY_ARTICLE_TYPE,
    headline: data.paper.title,
    name: data.paper.title,
    url: absoluteSiteUrl(
      paperCanonicalPath(data, options.versionPage),
      options.siteUrl,
    ),
    author: data.paper.authors.map(personOf),
    identifier: {
      "@type": "PropertyValue",
      propertyID: "sch",
      value: data.versionId,
    },
    isAccessibleForFree: true,
    version: data.version,
    publisher: {
      "@type": "Organization",
      name: CITATION_PUBLISHER,
    },
    creativeWorkStatus: creativeWorkStatus(data.paper.status),
  };

  const abstract = data.paper.abstract.trim();
  if (abstract !== "") {
    article.abstract = abstract;
  }

  const listedAt = versionListedAt(data);
  if (listedAt !== null) {
    article.datePublished = listedAt;
    article.dateModified = listedAt;
  }

  const licence = data.paper.licence.trim();
  if (licence !== "") {
    article.license = licence;
  }

  return article;
}

/**
 * The JSON text of a value, safe inside a `<script>` element: every `<` is
 * escaped as a Unicode escape, so no string (`</script>` included) can close it.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export interface ScholarlyArticleJsonLdProps {
  readonly data: PaperPageData;
  /** The URL names one version (`/p/{id}/v{n}`) rather than the newest. */
  readonly versionPage: boolean;
  /** The site origin; defaults to {@link resolveSiteUrl}. */
  readonly siteUrl?: string;
}

/**
 * The page's `<script type="application/ld+json">`. Rendered only for a
 * listed paper — the route never reaches a successful render otherwise.
 */
export function ScholarlyArticleJsonLd({
  data,
  versionPage,
  siteUrl,
}: ScholarlyArticleJsonLdProps): ReactElement {
  const json = scholarlyArticle(data, { versionPage, siteUrl });
  // `createElement` rather than JSX: this module is a `.ts` file, so the
  // route can import it from a server component without a build step.
  return createElement("script", {
    type: "application/ld+json",
    dangerouslySetInnerHTML: { __html: serializeJsonLd(json) },
  });
}
