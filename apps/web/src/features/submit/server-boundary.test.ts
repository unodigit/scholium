// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `app/(submit)/submit/page.tsx` and `.../consent/[version]/page.tsx` are server
 * components that import this feature's barrel (`index.ts`), so every module the
 * barrel re-exports is evaluated on the server unless it is a client module
 * (`"use client"`). The `../web-auth` index re-exports React hooks that are not
 * client modules, so a plain module importing it breaks `next build` for both
 * pages ("You're importing a component that needs `useState`") while every unit
 * test still passes. Plain modules import the files they need instead
 * (`../web-auth/errors`, `../web-auth/sign-record`).
 */

const here = dirname(fileURLToPath(import.meta.url));

const sources = readdirSync(here)
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(here, name), "utf8") }));

const isClientModule = (text: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/.*\n\s*)*["']use client["']/.test(text);

/** A runtime import of the `web-auth` index (a type-only import is erased and harmless). */
const importsWebAuthIndex = (text: string) =>
  /^import\s+(?!type\b)[^;]*?from\s+["']\.\.\/web-auth["']/m.test(text) ||
  /^export\s+(?!type\b)[^;]*?from\s+["']\.\.\/web-auth["']/m.test(text);

describe("the submit feature's server/client boundary", () => {
  it("finds the feature's modules", () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.find((s) => s.name === "consent-version.ts")).toBeTruthy();
  });

  it("recognises a client module, with or without a comment above the directive", () => {
    expect(isClientModule('"use client";\n\nimport x from "y";')).toBe(true);
    expect(isClientModule('/**\n * doc\n */\n\n"use client";\n')).toBe(true);
    expect(isClientModule('import x from "y";\n')).toBe(false);
  });

  it("tells a runtime import of the web-auth index from the harmless ones", () => {
    // The shape of the bug: a plain module reaching the hooks through the index.
    expect(importsWebAuthIndex('import { signRecord } from "../web-auth";')).toBe(true);
    expect(importsWebAuthIndex('import {\n  isDeviceKeyError,\n  signRecord,\n} from "../web-auth";')).toBe(true);
    expect(importsWebAuthIndex('export { signRecord } from "../web-auth";')).toBe(true);
    // Erased at build time, or reaching only the plain files.
    expect(importsWebAuthIndex('import type { SignedRecord } from "../web-auth";')).toBe(false);
    expect(importsWebAuthIndex('import { isDeviceKeyError } from "../web-auth/errors";')).toBe(false);
  });

  it("keeps the web-auth index out of every plain module the barrel reaches", () => {
    const offenders = sources
      .filter((source) => !isClientModule(source.text) && importsWebAuthIndex(source.text))
      .map((source) => source.name);
    expect(offenders).toEqual([]);
  });
});
