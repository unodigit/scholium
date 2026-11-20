// @vitest-environment node
import { parse as parseQuery, stringify as stringifyQuery } from "node:querystring";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRedirectStatus } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { matchHas, prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FEED_STATE, FEED_PATH, feedHref } from "./src/features/feed/feed";
import { DEFAULT_API_BASE_URL, resolveApiBaseUrl } from "./src/lib/api/client";
import nextConfig from "./next.config.js";

/**
 * The web app's security headers.
 *
 * Next.js emits whatever `headers()` in next.config.js returns, so these tests
 * read the policy the same way Next does and assert what a browser will be
 * told: a strict Content-Security-Policy (this origin plus the API origin, no
 * `unsafe-eval` in production), no framing, no MIME sniffing, a strict
 * Referrer-Policy and a Permissions-Policy that switches off powers the app
 * never uses. Each directive is checked against the feature that needs it
 * (WebAuthn, KaTeX, the PDF.js viewer) so tightening the policy later cannot
 * quietly break one of them.
 */

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function rules(): Promise<HeaderRule[]> {
  expect(nextConfig.headers, "next.config.js must define headers()").toBeTypeOf("function");
  return (await nextConfig.headers!()) as HeaderRule[];
}

/** Every header sent for `path`'s rule, keyed by lower-cased name. */
async function sentHeaders(): Promise<Map<string, string>> {
  const all = await rules();
  // One rule must cover every route, `/` included; otherwise a page escapes.
  const covering = all.filter((rule) => rule.source === "/:path*");
  expect(covering).toHaveLength(1);
  const sent = new Map<string, string>();
  for (const { key, value } of covering[0].headers) {
    expect(sent.has(key.toLowerCase()), `${key} is sent twice`).toBe(false);
    sent.set(key.toLowerCase(), value);
  }
  return sent;
}

/** `a b; c 'self'` → `{ a: ["b"], c: ["'self'"] }`. */
function directives(policy: string): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      expect(parsed[name], `CSP repeats ${name}`).toBeUndefined();
      parsed[name] = sources;
    }
  }
  return parsed;
}

async function csp(): Promise<Record<string, string[]>> {
  const value = (await sentHeaders()).get("content-security-policy");
  expect(value, "Content-Security-Policy is sent").toBeTruthy();
  return directives(value!);
}

/** Production mode; an empty `apiUrl` is "not set", as the client reads it. */
function production(apiUrl = "https://api.scholium.test") {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_API_URL", apiUrl);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Content-Security-Policy", () => {
  it("is sent on every route and starts from same-origin only", async () => {
    production();
    const policy = await csp();
    expect(policy["default-src"]).toEqual(["'self'"]);
  });

  it("allows connections to this origin and the configured API origin, and no other", async () => {
    production("https://api.scholium.test");
    const policy = await csp();
    expect(policy["connect-src"]).toEqual(["'self'", "https://api.scholium.test"]);
  });

  it("reduces the API URL to its origin (a path or trailing slash is not part of one)", async () => {
    production("https://api.scholium.test:8443/v1/");
    expect((await csp())["connect-src"]).toContain("https://api.scholium.test:8443");
  });

  it("falls back to the same API origin the client falls back to", async () => {
    production("");
    expect(resolveApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
    expect((await csp())["connect-src"]).toContain(new URL(DEFAULT_API_BASE_URL).origin);
  });

  it("allows exactly what the client will call for any configured API URL", async () => {
    for (const apiUrl of ["https://api.scholium.test", "https://api.scholium.test/", "http://127.0.0.1:9000"]) {
      production(apiUrl);
      expect((await csp())["connect-src"]).toContain(new URL(resolveApiBaseUrl()).origin);
    }
  });

  it("never allows eval in production", async () => {
    production();
    const value = (await sentHeaders()).get("content-security-policy")!;
    // Also rules out `'wasm-unsafe-eval'`: PDF.js falls back to its interpreter
    // when WebAssembly compilation is refused, so the viewer does not need it.
    expect(value).not.toContain("unsafe-eval");
  });

  it("allows eval only in development, where React's dev tooling needs it", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await csp())["script-src"]).toContain("'unsafe-eval'");
  });

  it("forbids being framed", async () => {
    production();
    expect((await csp())["frame-ancestors"]).toEqual(["'none'"]);
    // Browsers that predate frame-ancestors read this instead.
    expect((await sentHeaders()).get("x-frame-options")).toBe("DENY");
  });

  it("locks down plugins, <base> and form targets", async () => {
    production();
    const policy = await csp();
    expect(policy["object-src"]).toEqual(["'none'"]);
    expect(policy["base-uri"]).toEqual(["'self'"]);
    expect(policy["form-action"]).toEqual(["'self'"]);
  });

  it("never allows a wildcard or a whole scheme as a source", async () => {
    production();
    for (const [name, sources] of Object.entries(await csp())) {
      for (const source of sources) {
        expect(source, `${name} allows ${source}`).not.toMatch(/^(\*|https?:|wss?:|ftp:)$/);
        expect(source, `${name} allows ${source}`).not.toContain("*");
      }
    }
  });

  it("keeps scripts first-party", async () => {
    production();
    const sources = (await csp())["script-src"];
    expect(sources).toContain("'self'");
    // No third-party script host: every entry is a keyword, not a URL.
    for (const source of sources) {
      expect(source).toMatch(/^'[a-z-]+'$/);
    }
  });

  it("lets the PDF.js worker start from this origin and the viewer fetch the PDF from the API", async () => {
    production("https://api.scholium.test");
    const policy = await csp();
    // `worker-src` falls back to `script-src` when it is absent.
    const workerSources = policy["worker-src"] ?? policy["script-src"];
    expect(workerSources).toContain("'self'");
    // The PDF is fetched from the API's content endpoint.
    expect(policy["connect-src"]).toContain("https://api.scholium.test");
  });

  it("lets KaTeX's inline style attributes and bundled fonts through", async () => {
    production();
    const policy = await csp();
    // KaTeX positions every glyph with an inline `style` attribute; React's
    // `style={{…}}` props are the same thing.
    expect(policy["style-src"]).toContain("'self'");
    expect(policy["style-src"]).toContain("'unsafe-inline'");
    // katex.min.css's fonts are bundled by Next and served from /_next/static.
    expect(policy["font-src"] ?? policy["default-src"]).toContain("'self'");
  });
});

describe("the standalone build the web image runs", () => {
  it("emits a self-contained server instead of requiring node_modules at runtime", () => {
    expect(nextConfig.output).toBe("standalone");
  });

  it("traces from the npm workspace root so the server lands at apps/web/server.js", () => {
    // The Containerfile copies .next/standalone/apps/web/server.js. A root that
    // is inferred from an enclosing lockfile would move it (and every asset
    // path) somewhere else, so the config pins it to the workspace root.
    const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    expect(nextConfig.outputFileTracingRoot).toBe(workspaceRoot);
    expect(path.relative(nextConfig.outputFileTracingRoot!, fileURLToPath(import.meta.url))).toBe(
      path.join("apps", "web", "next.config.test.ts"),
    );
  });
});

describe("the other security headers", () => {
  it("stops MIME sniffing", async () => {
    production();
    expect((await sentHeaders()).get("x-content-type-options")).toBe("nosniff");
  });

  it("sends a strict Referrer-Policy", async () => {
    production();
    expect((await sentHeaders()).get("referrer-policy")).toBe("no-referrer");
  });

  it("sends a Permissions-Policy that disables powers the app never uses", async () => {
    production();
    const value = (await sentHeaders()).get("permissions-policy");
    expect(value, "Permissions-Policy is sent").toBeTruthy();
    const features = Object.fromEntries(
      value!.split(",").map((entry) => {
        const [name, allowlist] = entry.trim().split("=");
        return [name, allowlist];
      }),
    );
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(features[feature], `${feature} is disabled`).toBe("()");
    }
  });

  it("leaves WebAuthn (passkey create and get) enabled for this origin", async () => {
    production();
    const value = (await sentHeaders()).get("permissions-policy")!;
    // `publickey-credentials-*=()` would make navigator.credentials.create/get
    // reject on every page: sign-in and recovery both go through them.
    expect(value).not.toMatch(/publickey-credentials-(get|create)=\(\)/);
    expect(value).toContain("publickey-credentials-get=(self)");
    expect(value).toContain("publickey-credentials-create=(self)");
  });
});

describe("a bad API URL", () => {
  it("is refused rather than shipped as a policy that blocks every API call", async () => {
    production("api.scholium.test");
    await expect(rules()).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
  });

  it("cannot smuggle in another directive", async () => {
    // `;` and `,` are legal in a URL host, and either would start a directive.
    for (const apiUrl of [
      "https://api.scholium.test;script-src",
      "https://api.scholium.test;script-src *",
      "https://api.scholium.test,x",
      "javascript:alert(1)",
    ]) {
      production(apiUrl);
      await expect(rules(), apiUrl).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    }
  });
});

/**
 * The feed's legacy links.
 *
 * The feed used to live at `/`, so `/?tab=reviewed`, `/?category=cs.AI` and
 * `/?sort=recently_updated` are in bookmarks and shared links. The homepage now
 * owns `/`, and `next.config.js` sends any request for `/` that carries one of
 * the feed's query parameters to `/papers` with the same query string, with a
 * permanent (308) redirect. A bare `/` is not redirected.
 *
 * `redirects()` is resolved the way Next's router resolves a request: the
 * rule's `source` against the pathname, its `has` conditions against the
 * query, then the destination prepared with the request's query merged in and
 * the status read from `permanent`. Those are Next's own functions, so the
 * assertions are about what a browser receives, not about the shape of the
 * config object.
 */

type RedirectRule = {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: number;
  has?: { type: "query"; key: string; value?: string }[];
  missing?: { type: "query"; key: string; value?: string }[];
};

async function redirectRules(): Promise<RedirectRule[]> {
  expect(nextConfig.redirects, "next.config.js must define redirects()").toBeTypeOf("function");
  return (await nextConfig.redirects!()) as RedirectRule[];
}

/** What `GET <url>` answers, or `null` when no redirect rule applies. */
async function redirectFor(url: string): Promise<{ status: number; location: string } | null> {
  const { pathname, search } = new URL(url, "http://scholium.test");
  const query = parseQuery(search.replace(/^\?/, ""));
  for (const rule of await redirectRules()) {
    const params = getPathMatch(rule.source)(pathname);
    if (!params) continue;
    const hasParams = matchHas({ headers: {} } as never, query, rule.has, rule.missing);
    if (!hasParams) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params: { ...params, ...hasParams },
      query,
    });
    const search = stringifyQuery(parsedDestination.query);
    return {
      status: getRedirectStatus(rule),
      location: `${parsedDestination.pathname}${search === "" ? "" : `?${search}`}`,
    };
  }
  return null;
}

describe("legacy feed links", () => {
  it("redirect GET /?tab=reviewed to /papers?tab=reviewed with a 308", async () => {
    expect(await redirectFor("/?tab=reviewed")).toEqual({
      status: 308,
      location: "/papers?tab=reviewed",
    });
  });

  it("redirect /?tab=… for every tab the feed has", async () => {
    for (const tab of ["latest", "reviewed", "following"]) {
      expect(await redirectFor(`/?tab=${tab}`), tab).toEqual({
        status: 308,
        location: `/papers?tab=${tab}`,
      });
    }
  });

  it("redirect /?category=… with the category intact", async () => {
    expect(await redirectFor("/?category=cs.AI")).toEqual({
      status: 308,
      location: "/papers?category=cs.AI",
    });
    // A category the URL had to escape stays escaped.
    expect(await redirectFor("/?category=math%20ph")).toEqual({
      status: 308,
      location: "/papers?category=math%20ph",
    });
  });

  it("redirect /?sort=… for every sort the feed has", async () => {
    for (const sort of ["newest", "recently_reviewed", "recently_updated"]) {
      expect(await redirectFor(`/?sort=${sort}`), sort).toEqual({
        status: 308,
        location: `/papers?sort=${sort}`,
      });
    }
  });

  it("carry every parameter across, not only the one that matched", async () => {
    expect(await redirectFor("/?tab=reviewed&category=cs.AI&sort=recently_reviewed")).toEqual({
      status: 308,
      location: "/papers?tab=reviewed&category=cs.AI&sort=recently_reviewed",
    });
    expect(await redirectFor("/?sort=recently_updated&category=cs.LG")).toEqual({
      status: 308,
      location: "/papers?sort=recently_updated&category=cs.LG",
    });
  });

  it("redirect when the feed's parameter comes with one the feed does not know", async () => {
    expect(await redirectFor("/?utm_source=mail&tab=reviewed")).toEqual({
      status: 308,
      location: "/papers?utm_source=mail&tab=reviewed",
    });
  });

  it("redirect to the URL the feed itself builds for the same view", async () => {
    const views = [
      { tab: "reviewed" as const, category: "", sort: "newest" as const },
      { tab: "latest" as const, category: "cs.AI", sort: "newest" as const },
      { tab: "latest" as const, category: "", sort: "recently_updated" as const },
      { tab: "following" as const, category: "stat.ML", sort: "recently_reviewed" as const },
    ];
    for (const view of views) {
      const legacy = feedHref(view, "/");
      expect(legacy.startsWith("/?"), legacy).toBe(true);
      expect(await redirectFor(legacy), legacy).toEqual({
        status: 308,
        location: feedHref(view),
      });
    }
  });

  it("are permanent redirects, and say so with 308 rather than 301", async () => {
    const legacy = (await redirectRules()).filter((rule) => rule.source === "/");
    expect(legacy.length).toBeGreaterThan(0);
    for (const rule of legacy) {
      expect(rule.permanent).toBe(true);
      expect(rule.statusCode).toBeUndefined();
      expect(getRedirectStatus(rule)).toBe(308);
    }
  });

  it("cover exactly the feed's own query parameters, and send them to the feed's path", async () => {
    const keys = Object.keys(DEFAULT_FEED_STATE).sort();
    expect(keys).toEqual(["category", "sort", "tab"]);

    const rules = (await redirectRules()).filter((rule) => rule.source === "/");
    const covered = rules.flatMap((rule) => (rule.has ?? []).map((condition) => condition.key));
    expect(covered.sort()).toEqual(keys);
    for (const rule of rules) {
      expect(rule.destination).toBe(FEED_PATH);
      expect(rule.destination).toBe("/papers");
      expect(rule.missing ?? []).toEqual([]);
    }
  });

  it("leave the bare / alone for the homepage", async () => {
    expect(await redirectFor("/")).toBeNull();
  });

  it("leave / alone when its query carries none of the feed's parameters", async () => {
    for (const url of ["/?", "/?utm_source=mail", "/?ref=home&utm_campaign=x", "/?cursor=abc", "/?Tab=reviewed"]) {
      expect(await redirectFor(url), url).toBeNull();
    }
  });

  it("leave / alone when a feed parameter is present but empty", async () => {
    // Next matches `has: query` on a non-empty value, and the feed reads an
    // empty value as its default view, so the homepage serves these.
    for (const url of ["/?tab=", "/?category=", "/?sort="]) {
      expect(await redirectFor(url), url).toBeNull();
    }
  });

  it("do not redirect the feed itself, so /papers?tab=… is served rather than looped", async () => {
    for (const url of ["/papers", "/papers?tab=reviewed", "/papers?category=cs.AI&sort=newest"]) {
      expect(await redirectFor(url), url).toBeNull();
    }
  });

  it("only apply to /, not to other pages that happen to use the same parameters", async () => {
    for (const url of ["/search?sort=newest", "/c/cs.AI?tab=reviewed", "/paper/x?category=cs.AI"]) {
      expect(await redirectFor(url), url).toBeNull();
    }
  });
});
