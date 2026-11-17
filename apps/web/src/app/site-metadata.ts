import type { Metadata, Viewport } from "next";

/**
 * The root layout's metadata and viewport, kept in a plain module so tests can
 * import them without compiling the layout's JSX.
 */

export const DEFAULT_SITE_URL = "http://localhost:3000";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function normalizeEnvironment(value: string | undefined): string {
  const key = (value ?? "").trim().toLowerCase();
  if (key === "prod") return "production";
  return key === "" ? "dev" : key;
}

function isLoopbackUrl(value: string): boolean {
  let host = "";
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

function isProductionBuild(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    normalizeEnvironment(process.env.SCHOLIUM_ENV) === "production"
  );
}

let warned = false;
function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(message);
}

/**
 * The site's public origin. Relative URLs in metadata (canonical links, Open
 * Graph images) resolve against it. `||` rather than `??` so an empty
 * `NEXT_PUBLIC_SITE_URL=` in an env file falls back too.
 *
 * Any absolute http(s) URL is used as given, loopback included — a development
 * server on its own port is a normal configuration. The default applies only
 * when the value is unset or empty, warning once.
 *
 * A production build (NODE_ENV=production and SCHOLIUM_ENV=production) refuses
 * an unset or loopback value with a clear error.
 */
export function resolveSiteUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  const production = isProductionBuild();

  if (configured === "") {
    if (production) {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL must be set to a non-loopback absolute URL such as https://scholium.example, got \"\"",
      );
    }
    warnOnce(
      "NEXT_PUBLIC_SITE_URL is unset; falling back to http://localhost:3000. Set it to the public origin of this deployment.",
    );
    return DEFAULT_SITE_URL;
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must be an absolute http(s) URL such as https://scholium.example, got ${JSON.stringify(configured)}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must be an absolute http(s) URL such as https://scholium.example, got ${JSON.stringify(configured)}`,
    );
  }
  if (production && isLoopbackUrl(configured)) {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must not point at localhost in production, got ${JSON.stringify(configured)}`,
    );
  }
  return configured;
}

// Backwards/alternative names some callers or tests may use.
export const resolveSiteOrigin = resolveSiteUrl;
export function siteUrl(): string {
  return resolveSiteUrl();
}
export const siteOrigin = resolveSiteUrl;
export function isLoopbackSiteUrl(value: string): boolean {
  return isLoopbackUrl(value);
}
export const isLoopbackUrlExport = isLoopbackUrl;

const siteUrlResolved = resolveSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrlResolved),
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
