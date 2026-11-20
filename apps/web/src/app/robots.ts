import type { MetadataRoute } from "next";

import { resolveSiteUrl } from "./site-metadata";

/**
 * `/robots.txt`, served by Next from this file as an App Router metadata route.
 *
 * Crawling is allowed only in a production deployment (`NODE_ENV=production`
 * *and* `SCHOLIUM_ENV=production`). Every other environment answers
 * `Disallow: /` for every user agent, so a staging or development host can
 * never be indexed: its content and URLs are copies, not the site.
 *
 * Production allows every user agent and names the answer engines and AI
 * crawlers explicitly, with the same rules — a group for each would be the
 * same bytes, so they share one group. The private paths are all the signed-in
 * or moderation surfaces: they are not useful to a crawler and a few of them
 * echo a person's own account.
 */

/** The answer engines and AI crawlers named explicitly in production. */
export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
] as const;

/** Paths no crawler is ever allowed to read (docs/design.md §4). */
export const PRIVATE_PATHS = [
  "/me",
  "/mod",
  "/consent/",
  "/review/",
  "/onboarding",
  "/recover",
  "/verify-email",
  "/ui-kit",
] as const;

/**
 * Whether this is a production deployment.
 *
 * Both variables must say production: `NODE_ENV` alone is `production` inside
 * every optimised build (including a local `next build`), and `SCHOLIUM_ENV`
 * alone does not prove the build was optimised. `prod` is accepted as the same
 * word, matching `resolveSiteUrl`'s environment handling.
 */
export function isProductionDeployment(): boolean {
  const environment = (process.env.SCHOLIUM_ENV ?? "").trim().toLowerCase();
  const normalized = environment === "prod" ? "production" : environment;
  return process.env.NODE_ENV === "production" && normalized === "production";
}

/** The rules shared by every group: allow the site, refuse the private paths. */
function publicRules(): { allow: string; disallow: string[] } {
  return { allow: "/", disallow: [...PRIVATE_PATHS] };
}

export default function robots(): MetadataRoute.Robots {
  if (!isProductionDeployment()) {
    return {
      rules: { userAgent: "*", disallow: "/" },
    };
  }

  return {
    rules: [
      { userAgent: "*", ...publicRules() },
      { userAgent: [...AI_CRAWLERS], ...publicRules() },
    ],
    // Absolute, from the one source of absolute URLs (site-metadata.ts).
    sitemap: `${resolveSiteUrl().replace(/\/+$/, "")}/sitemap.xml`,
  };
}
