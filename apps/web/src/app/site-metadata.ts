import type { Metadata, Viewport } from "next";

/**
 * The root layout's metadata and viewport, kept in a plain module so tests can
 * import them without compiling the layout's JSX.
 */

const DEFAULT_SITE_URL = "http://localhost:3000";

/**
 * The site's public origin. Relative URLs in metadata (canonical links, Open
 * Graph images) resolve against it. `||` rather than `??` so an empty
 * `NEXT_PUBLIC_SITE_URL=` in an env file falls back too.
 */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "Scholium",
  title: {
    default: "Scholium",
    template: "%s · Scholium",
  },
  description: "Signed, open preprints and peer review",
};

/** Browser chrome follows the page: paper in light mode, ink in dark mode. */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FBFAF7" },
    { media: "(prefers-color-scheme: dark)", color: "#14151A" },
  ],
};
