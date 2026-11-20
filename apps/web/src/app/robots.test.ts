// @vitest-environment node
import type { MetadataRoute } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

import robots, { AI_CRAWLERS, PRIVATE_PATHS } from "./robots";

/**
 * `/robots.txt` is a promise about every environment at once: production is
 * crawlable, and everything else (staging, development, a local build) is not.
 * These tests read the metadata route the way Next serialises it — one group
 * per user agent — and pin both sides of that promise.
 */

type RobotsRule = {
  userAgent: string | string[];
  allow?: string | string[];
  disallow?: string | string[];
};

/** Next accepts one rule or a list; flatten to a list for assertions. */
function groups(output: MetadataRoute.Robots): RobotsRule[] {
  return (Array.isArray(output.rules) ? output.rules : [output.rules]) as RobotsRule[];
}

function stubEnvironment(environment: {
  nodeEnv?: string;
  scholiumEnv?: string;
  siteUrl?: string;
}): void {
  vi.stubEnv("NODE_ENV", environment.nodeEnv ?? "test");
  vi.stubEnv("SCHOLIUM_ENV", environment.scholiumEnv ?? "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", environment.siteUrl ?? "https://scholium.test");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the production robots.txt", () => {
  it("allows every user agent and names the answer engines and AI crawlers", () => {
    stubEnvironment({ nodeEnv: "production", scholiumEnv: "production" });

    const output = robots();
    const rules = groups(output);

    expect(rules).toHaveLength(2);
    expect(rules[0].userAgent).toBe("*");
    expect(rules[1].userAgent).toEqual([
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
    ]);
    expect([...AI_CRAWLERS]).toEqual(rules[1].userAgent);
  });

  it("gives the named agents exactly the rules the wildcard has", () => {
    stubEnvironment({ nodeEnv: "production", scholiumEnv: "production" });

    const [wildcard, named] = groups(robots());

    expect(wildcard.allow).toBe("/");
    expect(named.allow).toBe(wildcard.allow);
    expect(named.disallow).toEqual(wildcard.disallow);
  });

  it("disallows the private paths and nothing else", () => {
    stubEnvironment({ nodeEnv: "production", scholiumEnv: "production" });

    for (const rule of groups(robots())) {
      expect(rule.disallow).toEqual([
        "/me",
        "/mod",
        "/consent/",
        "/review/",
        "/onboarding",
        "/recover",
        "/verify-email",
        "/ui-kit",
      ]);
      expect([...PRIVATE_PATHS]).toEqual(rule.disallow);
    }
  });

  it("points at the absolute sitemap built from the site URL", () => {
    stubEnvironment({
      nodeEnv: "production",
      scholiumEnv: "production",
      siteUrl: "https://scholium.test",
    });

    expect(robots().sitemap).toBe("https://scholium.test/sitemap.xml");
  });

  it("accepts `prod` as the production environment", () => {
    stubEnvironment({ nodeEnv: "production", scholiumEnv: "prod" });

    expect(groups(robots())[0].userAgent).toBe("*");
    expect(groups(robots())[0].disallow).toEqual([...PRIVATE_PATHS]);
  });
});

describe("robots.txt outside production", () => {
  const forbidden = [
    { name: "the test environment", nodeEnv: "test", scholiumEnv: "" },
    { name: "a development server", nodeEnv: "development", scholiumEnv: "development" },
    { name: "a staging deployment", nodeEnv: "production", scholiumEnv: "staging" },
    { name: "a production build without SCHOLIUM_ENV", nodeEnv: "production", scholiumEnv: "" },
    { name: "a production environment without NODE_ENV", nodeEnv: "development", scholiumEnv: "production" },
  ];

  for (const environment of forbidden) {
    it(`disallows everything in ${environment.name}`, () => {
      stubEnvironment(environment);

      const output = robots();
      const rules = groups(output);

      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual({ userAgent: "*", disallow: "/" });
      expect(output.sitemap).toBeUndefined();
    });
  }
});
