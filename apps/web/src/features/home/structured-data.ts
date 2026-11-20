/**
 * What the homepage publishes for machines: its `<head>` metadata and one
 * schema.org JSON-LD `@graph` (docs/design.md §5.9, "GEO surfaces").
 *
 * Search and answer engines identify Scholium from a small set of facts: what
 * the site is called, who publishes it, what the app is and costs, what the
 * name means and which questions it answers. The graph states exactly those,
 * and only what a visitor can read on the page: the `FAQPage` is built from
 * {@link FAQ_ENTRIES}, the same data the visible FAQ renders, so its questions
 * and answers cannot drift from the page.
 *
 * The rules the callers rely on:
 *
 * - **Absolute URLs from one source.** Every URL is built from
 *   {@link resolveSiteUrl} (`NEXT_PUBLIC_SITE_URL`), never a hard-coded domain,
 *   so a staging site never advertises production URLs. The one URL that does
 *   not come from it is the schema.org vocabulary IRI in `@context`.
 * - **Script-safe JSON.** {@link serializeJsonLd} escapes every `<`, so no
 *   string can close the `<script>` element.
 * - **Static.** Nothing here reads a request, a clock or the API, so the page
 *   stays prerendered. `dateModified` is a constant that moves with the copy.
 *
 * Pure data and functions, server-safe, no JSX: the route's page renders the
 * script element and passes `homeMetadata()` straight through as `metadata`.
 */

import type { Metadata } from "next";

import { resolveSiteUrl } from "../../app/site-metadata";
// faq.ts (the data) and faq.tsx (the section) share a basename, and Next's
// bundler resolves a bare "./faq" to the .tsx, Vite to the .ts. The explicit
// extension names the data in both. The ts-expect-error silences TS5097, which
// fires for any import that ends in ".ts".
// @ts-expect-error "./faq.ts" needs its extension to be unambiguous
import { FAQ_ENTRIES } from "./faq.ts";

/** The page title, absolute: the root layout's "%s · Scholium" template is not applied. */
export const HOME_TITLE = "Scholium — signed, open preprints and peer review";

/** The meta description (docs/homepage/index.html). */
export const HOME_DESCRIPTION =
  "Scholium is a free preprint and peer-review network. Every paper, version and review is signed by its author, reviewed in the open beside the text, and verifiable offline by anyone.";

/** The Open Graph card's description (docs/homepage/index.html). */
export const HOME_OG_DESCRIPTION =
  "Publish preprints signed by you, get structured peer review in the open, and keep a record anyone can verify offline. Free to read and to publish.";

/** The Twitter card's description (docs/homepage/index.html). */
export const HOME_TWITTER_DESCRIPTION =
  "Preprints signed by their authors, structured peer review in the open, and a record anyone can verify offline.";

/** The share card both cards use: the site card `app/opengraph-image.tsx` serves. */
export const HOME_SHARE_IMAGE_PATH = "/opengraph-image";

/**
 * What the share card shows: the wordmark and the tagline. This is the card's
 * own alt text (`BRAND_CARD_ALT` in `features/ui-kit/brand-card.tsx`), kept as
 * a literal because that module renders images and must stay out of the page
 * bundle; a test keeps the two equal.
 */
export const HOME_SHARE_IMAGE_ALT = "scholium: Signed, open preprints and peer review";

/** The share card's size, which `app/opengraph-image.tsx` declares. */
export const HOME_SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;

/** The language the page is written in. */
export const HOME_LANGUAGE = "en";

/**
 * When the page's copy last changed (ISO date). A constant on purpose: the page
 * is prerendered, and a date taken at build time would claim a change that did
 * not happen. Update it with the copy.
 */
export const HOME_DATE_MODIFIED = "2026-11-20";

/**
 * What the app does today, as the reference lists it
 * (docs/homepage/index.html, `WebApplication.featureList`). Phase 1 features
 * only: anchoring, DOIs and independent nodes are not in it.
 */
export const HOME_FEATURE_LIST: readonly string[] = [
  "Preprints signed on the author's device with a passkey-protected key",
  "Version chain in which each version records the fingerprint of the one before",
  "Stable identifiers of the form sch:xxxx-xxxx-xxxx/vN",
  "Structured peer review against a six-criterion rubric",
  "Anonymous but accountable reviewers with conflict-of-interest checks",
  "Reports sealed until two reviewers have committed or 21 days pass",
  "Advisory AI pre-review with evidence links",
  "Paragraph-level annotations and discussion",
  "Signed corrections and retractions shown on every version",
  "Archive export that verifies offline with the scholium verify command",
  "Import from arXiv with author claiming",
  "Account recovery with three of five guardians",
  "CC BY 4.0 licence by default",
];

/** A schema.org node: the graph is plain JSON. */
export type JsonLdNode = Record<string, unknown>;

/** The document `homeJsonLd` returns. */
export interface HomeJsonLd {
  readonly "@context": "https://schema.org";
  readonly "@graph": readonly JsonLdNode[];
}

/**
 * An absolute URL on this site: `path` (root-relative) joined to the site
 * origin. The origin's trailing slashes are dropped so the join never doubles
 * one, and `/` gives the origin with a single trailing slash.
 */
export function absoluteUrl(path: string, siteUrl: string = resolveSiteUrl()): string {
  const origin = siteUrl.replace(/\/+$/, "");
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The JSON text of a value, safe inside a `<script>` element: every `<` is
 * escaped as a Unicode escape, so no string (`</script>` included) can close
 * it. `JSON.parse` reads the escaped text back to the same value.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The homepage's `@graph`: Organization, WebSite, WebPage, WebApplication,
 * DefinedTerm and FAQPage, linked by `@id`.
 *
 * @param siteUrl the site origin; defaults to {@link resolveSiteUrl}.
 */
export function homeJsonLd(siteUrl: string = resolveSiteUrl()): HomeJsonLd {
  const url = (path: string): string => absoluteUrl(path, siteUrl);
  const home = url("/");
  const organization = url("/#organization");
  const website = url("/#website");
  const app = url("/#app");

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organization,
        name: "Scholium",
        url: home,
        logo: {
          "@type": "ImageObject",
          url: url("/brand/icon-512.png"),
          width: 512,
          height: 512,
        },
        description:
          "Scholium runs a free preprint and peer-review network in which every paper, version and review is a signed, content-addressed record that anyone can verify.",
      },
      {
        "@type": "WebSite",
        "@id": website,
        url: home,
        name: "Scholium",
        alternateName: "Scholium Network",
        description: "Signed, open preprints and peer review.",
        inLanguage: HOME_LANGUAGE,
        publisher: { "@id": organization },
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            // Braces stay literal: the template's placeholder is not URL-encoded.
            urlTemplate: `${url("/search")}?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
      },
      {
        "@type": "WebPage",
        "@id": url("/#webpage"),
        url: home,
        name: HOME_TITLE,
        isPartOf: { "@id": website },
        about: { "@id": app },
        primaryImageOfPage: url(HOME_SHARE_IMAGE_PATH),
        inLanguage: HOME_LANGUAGE,
        dateModified: HOME_DATE_MODIFIED,
      },
      {
        "@type": "WebApplication",
        "@id": app,
        name: "Scholium",
        url: home,
        applicationCategory: "ReferenceApplication",
        operatingSystem: "Any modern web browser",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": organization },
        description:
          "A free preprint and open peer-review network. Authors sign every paper and version on their own device; reviewers post structured, signed reviews beside the text; readers can verify signatures and version history in the browser or offline.",
        featureList: [...HOME_FEATURE_LIST],
      },
      {
        "@type": "DefinedTerm",
        "@id": url("/#term-scholium"),
        name: "scholium",
        description: "An explanatory note written in the margin of a scholarly text. Plural: scholia.",
      },
      {
        "@type": "FAQPage",
        "@id": url("/#faq"),
        mainEntity: FAQ_ENTRIES.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: { "@type": "Answer", text: answer },
        })),
      },
    ],
  };
}

/**
 * The homepage's `metadata` export: an absolute title, the description, the
 * canonical URL, and Open Graph and Twitter large-image cards that use the
 * site's existing `/opengraph-image`.
 *
 * The cards are spelled out because a page that sets `openGraph` replaces the
 * root layout's whole object, and with it the file-based image Next would
 * otherwise add. URLs are absolute here rather than left to `metadataBase`, so
 * the canonical and the card links are the site's own whatever the layout says.
 *
 * @param siteUrl the site origin; defaults to {@link resolveSiteUrl}.
 */
export function homeMetadata(siteUrl: string = resolveSiteUrl()): Metadata {
  const home = absoluteUrl("/", siteUrl);
  const shareImage = absoluteUrl(HOME_SHARE_IMAGE_PATH, siteUrl);

  return {
    title: { absolute: HOME_TITLE },
    description: HOME_DESCRIPTION,
    alternates: {
      canonical: home,
      // The plain-text summary for language models (`app/llms.txt/route.ts`).
      types: {
        "text/markdown": [
          { url: absoluteUrl("/llms.txt", siteUrl), title: "Scholium summary for language models" },
        ],
      },
    },
    robots: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
    openGraph: {
      type: "website",
      siteName: "Scholium",
      locale: "en_AU",
      url: home,
      title: HOME_TITLE,
      description: HOME_OG_DESCRIPTION,
      images: [{ url: shareImage, ...HOME_SHARE_IMAGE_SIZE, alt: HOME_SHARE_IMAGE_ALT }],
    },
    twitter: {
      card: "summary_large_image",
      title: HOME_TITLE,
      description: HOME_TWITTER_DESCRIPTION,
      images: [{ url: shareImage, alt: HOME_SHARE_IMAGE_ALT }],
    },
  };
}
