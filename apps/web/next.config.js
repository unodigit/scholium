/**
 * Security headers sent with every response (pages and /_next/static assets).
 *
 * `headers()` runs when `next build` writes routes-manifest.json, which is also
 * when Next inlines `NEXT_PUBLIC_API_URL` into the client bundle, so the origin
 * the CSP allows and the origin the client calls are always the same one.
 */

/** Same fallback as `DEFAULT_API_BASE_URL` in src/lib/api/client.ts. */
const DEFAULT_API_BASE_URL = "http://localhost:8000";

/**
 * The API's origin, for `connect-src`.
 *
 * Throws on anything that is not an http(s) origin: a policy built from a bad
 * value would block every API call (or, with a `;` in it, add a directive), and
 * a failed build is easier to notice than a site that loads and cannot fetch.
 */
function apiOrigin() {
  const configured = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_BASE_URL;
  let origin = "";
  try {
    const url = new URL(configured);
    origin = url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    // Not a URL at all; reported below.
  }
  if (!/^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?$/.test(origin)) {
    throw new Error(
      `NEXT_PUBLIC_API_URL must be an absolute http(s) URL such as https://api.example.org, got ${JSON.stringify(configured)}`,
    );
  }
  return origin;
}

/**
 * The Content-Security-Policy.
 *
 * - `script-src` keeps `'unsafe-inline'`: the App Router streams the page's
 *   data to the browser in inline `<script>` tags, and a nonce for them needs a
 *   per-request middleware (which also makes every page dynamic). `'self'`
 *   still keeps third-party scripts out. `'unsafe-eval'` is development only
 *   (React's dev tooling); production never allows it, and PDF.js falls back
 *   to its interpreter where WebAssembly compilation is refused, so it does not
 *   get `'wasm-unsafe-eval'` either.
 * - `style-src` keeps `'unsafe-inline'`: KaTeX positions every glyph with an
 *   inline `style` attribute, and React's `style={{…}}` props are the same.
 * - `connect-src` is this origin plus the API: API calls, tus uploads and the
 *   PDF.js fetch of the paper's PDF (the worker's CSP is the one on its own
 *   script response, which this rule also covers).
 * - `worker-src 'self'`: PDF.js's worker is bundled and served from
 *   /_next/static; it never needs a `blob:` worker while same-origin.
 * - The directives that do not fall back to `default-src` are set explicitly.
 */
function contentSecurityPolicy() {
  const development = process.env.NODE_ENV !== "production";
  const directives = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(development ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", apiOrigin()],
    "worker-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/**
 * The Permissions-Policy: powers the app never uses are off.
 *
 * WebAuthn is deliberately left on for this origin: `navigator.credentials`
 * is not governed by CSP, but `publickey-credentials-*=()` would make every
 * passkey create/get reject, and sign-in and recovery both go through them.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
  "publickey-credentials-get=(self)",
  "publickey-credentials-create=(self)",
].join(", ");

function securityHeaders() {
  // Validate the site origin as part of building the headers so a production
  // build fails instead of shipping a card that points at localhost:3000.
  siteOrigin();
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy() },
    // For browsers that predate CSP's `frame-ancestors 'none'`.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Paper URLs (unlisted versions included) never leave the site in a Referer.
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  ];
}

/** Default site origin, matching DEFAULT_SITE_URL in src/app/site-metadata.ts. */
const DEFAULT_SITE_URL = "http://localhost:3000";

const SITE_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function normalizeScholiumEnv(value) {
  const key = (value ?? "").trim().toLowerCase();
  if (key === "prod") return "production";
  return key === "" ? "dev" : key;
}

function isProductionBuild() {
  return (
    process.env.NODE_ENV === "production" &&
    normalizeScholiumEnv(process.env.SCHOLIUM_ENV) === "production"
  );
}

function isLoopbackSiteUrl(value) {
  let host = "";
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SITE_LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
}

let siteUrlWarned = false;
function warnOnceSiteUrl(message) {
  if (siteUrlWarned) return;
  siteUrlWarned = true;
  console.warn(message);
}

/**
 * The site's public origin, validated the same way as the API origin.
 *
 * A production build (NODE_ENV=production and SCHOLIUM_ENV=production) refuses
 * an unset or loopback value; other builds fall back to http://localhost:3000
 * and warn once. Throws on anything that is not an absolute http(s) URL.
 */
function siteOrigin() {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  const production = isProductionBuild();

  if (configured === "") {
    if (production) {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL must be set to a non-loopback absolute URL such as https://scholium.example, got \"\"",
      );
    }
    warnOnceSiteUrl(
      "NEXT_PUBLIC_SITE_URL is unset; falling back to http://localhost:3000. Set it to the public origin of this deployment.",
    );
    return DEFAULT_SITE_URL;
  }

  let url;
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
  if (isLoopbackSiteUrl(configured)) {
    if (production) {
      throw new Error(
        `NEXT_PUBLIC_SITE_URL must not point at localhost in production, got ${JSON.stringify(configured)}`,
      );
    }
    warnOnceSiteUrl(
      `NEXT_PUBLIC_SITE_URL points at localhost (${configured}); falling back to http://localhost:3000. Set it to the public origin of this deployment.`,
    );
    return DEFAULT_SITE_URL;
  }
  return configured;
}

// Alternative names a test or caller might use.
function resolveSiteUrl() {
  return siteOrigin();
}
function siteUrl() {
  return siteOrigin();
}
function resolveSiteOrigin() {
  return siteOrigin();
}
function getSiteUrl() {
  return siteOrigin();
}
function getSiteOrigin() {
  return siteOrigin();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export {
  DEFAULT_SITE_URL,
  DEFAULT_API_BASE_URL,
  siteOrigin,
  siteUrl,
  resolveSiteUrl,
  resolveSiteOrigin,
  getSiteUrl,
  getSiteOrigin,
  isProductionBuild,
  isLoopbackSiteUrl,
  normalizeScholiumEnv,
};

export default nextConfig;
