// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDBOOK_DIR,
  chapters,
  getChapter,
  githubAnchor,
  headingAnchors,
  quickStartByRole,
  resolveHandbookHref,
  type HandbookVideo,
} from "./handbook";

/**
 * The handbook the docs pages are generated from.
 *
 * These tests guard the promises the docs make: the 11 chapters exist in order,
 * every link a reader can click lands on a real chapter and a real heading,
 * every screenshot belongs to a heading that exists and to a file in
 * `apps/web/public`, and every chapter video points at a poster that exists and,
 * once uploaded, a YouTube URL the player can embed.
 */

const README = readFileSync(path.join(HANDBOOK_DIR, "README.md"), "utf8");
const PUBLIC_DIR = path.resolve(HANDBOOK_DIR, "../../apps/web/public");
const SCREENSHOTS: Record<string, { src: string; heading: string }[]> = JSON.parse(
  readFileSync(path.join(HANDBOOK_DIR, "screenshots.json"), "utf8"),
);
const VIDEOS: Record<string, HandbookVideo> = JSON.parse(
  readFileSync(path.join(HANDBOOK_DIR, "videos.json"), "utf8"),
);

const SLUGS = [
  "how-scholium-works",
  "your-account",
  "reading-and-finding-papers",
  "checking-a-paper-is-genuine",
  "publishing-a-paper",
  "reviewing-a-paper",
  "discussion-and-annotations",
  "ai-pre-review",
  "moderation-appeals-and-reports",
  "faq-and-known-limitations",
  "glossary",
];

const SUMMARIES = [
  "Understand the ideas, the roles and the life of a paper",
  "Sign in, set up your account, move up the trust tiers, protect your account",
  "Browse, search, follow, read and cite",
  "Understand the Verified badge and check files yourself",
  "Submit a paper, get co-author consent, through moderation to listing",
  "Write a formal review; understand how status is decided",
  "Comment on papers and annotate paragraphs",
  "Read and respond to the advisory AI report",
  "Understand decisions, appeal one, report content, moderate",
  "Find quick answers and what this release cannot do yet",
  "Look up a term",
];

/** Markdown lines outside fenced code blocks. */
function proseLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(```+|~~~+)/.exec(line);
    if (marker) {
      const kind = marker[1][0];
      fence = fence === null ? kind : fence === kind ? null : fence;
      continue;
    }
    if (fence === null) lines.push(line);
  }
  return lines;
}

/** Every Markdown link target in a document, images excluded. */
function links(markdown: string): string[] {
  const found: string[] = [];
  // A local copy of the pattern: tests must not go through the parser they check.
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)) {
    found.push(match[1]);
  }
  return found;
}

/** The anchor ids of a Markdown document's headings, as GitHub would make them. */
function anchorsOf(markdown: string): string[] {
  const texts = proseLines(markdown)
    .map((line) => /^#{1,6}\s+(.*?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
  return headingAnchors(texts);
}

/** Resolve `/docs/slug#anchor` back to its parts, or null for a plain page. */
function parseDocsHref(href: string): { slug: string | null; anchor: string | null } | null {
  const match = /^\/docs(?:\/([^#/]+))?(?:#(.+))?$/.exec(href);
  if (!match) return null;
  return { slug: match[1] ?? null, anchor: match[2] ?? null };
}

describe("the handbook chapters", () => {
  it("has the 11 chapters, in number order", () => {
    expect(chapters.map((chapter) => chapter.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it("has the slugs the docs routes use, in order", () => {
    expect(chapters.map((chapter) => chapter.slug)).toEqual(SLUGS);
    expect(chapters.map((chapter) => chapter.href)).toEqual(
      SLUGS.map((slug) => `/docs/${slug}`),
    );
  });

  it("gives each chapter its title, summary and body from the Markdown", () => {
    expect(chapters.map((chapter) => chapter.title)).toEqual([
      "How Scholium works",
      "Your account",
      "Reading and finding papers",
      "Checking a paper is genuine",
      "Publishing a paper",
      "Reviewing a paper",
      "Discussion and annotations",
      "AI pre-review",
      "Moderation, appeals and reports",
      "FAQ and known limitations",
      "Glossary",
    ]);
    expect(chapters.map((chapter) => chapter.summary)).toEqual(SUMMARIES);

    for (const chapter of chapters) {
      // The title line lives in `title`, not in the body the page renders.
      expect(chapter.heading).toMatch(/^\d+\.\s+\S/);
      expect(chapter.title).not.toMatch(/^\d+\.\s/);
      expect(chapter.body.length).toBeGreaterThan(0);
      expect(chapter.body.split("\n")[0]).not.toBe(`# ${chapter.heading}`);
      expect(chapter.body).not.toContain(`# ${chapter.heading}\n`);
    }
  });

  it("finds chapters by slug", () => {
    expect(getChapter("your-account")?.number).toBe(2);
    expect(getChapter("no-such-chapter")).toBeUndefined();
  });
});

describe("chapter headings", () => {
  it("keeps ## and ### headings with GitHub-style ids", () => {
    for (const chapter of chapters) {
      for (const heading of chapter.headings) {
        expect([2, 3]).toContain(heading.level);
        expect(heading.id).toMatch(/^[a-z0-9-]+$/);
        expect(githubAnchor(heading.text)).toBe(
          headingAnchors([heading.text])[0],
        );
      }
    }

    const account = getChapter("your-account")!;
    expect(account.headings.map((heading) => heading.id)).toEqual(
      expect.arrayContaining([
        "sign-in-with-a-passkey",
        "set-up-your-account-onboarding",
        "if-you-are-someones-guardian",
        "recover-a-lost-account",
      ]),
    );

    const reviewing = getChapter("reviewing-a-paper")!;
    expect(reviewing.headings.find((heading) => heading.text === "2. The conflict check")?.id).toBe(
      "2-the-conflict-check",
    );
  });

  it("turns punctuation into hyphens the way GitHub does", () => {
    expect(githubAnchor("For moderators: the console")).toBe("for-moderators-the-console");
    expect(githubAnchor("If you are someone's guardian")).toBe("if-you-are-someones-guardian");
    expect(githubAnchor("Can I delete my paper?")).toBe("can-i-delete-my-paper");
    expect(githubAnchor("Sign-in, then sign out")).toBe("sign-in-then-sign-out");
    expect(githubAnchor("The `sch:` ID (and its badge)")).toBe("the-sch-id-and-its-badge");
  });

  it("numbers repeated headings -1, -2", () => {
    expect(headingAnchors(["Repeat", "Repeat", "Repeat"])).toEqual([
      "repeat",
      "repeat-1",
      "repeat-2",
    ]);
    // A naturally suffixed heading keeps its own anchor, and the next repeat
    // steps past it instead of colliding.
    expect(headingAnchors(["Repeat", "Repeat-1", "Repeat"])).toEqual([
      "repeat",
      "repeat-1",
      "repeat-2",
    ]);
  });
});

describe("links", () => {
  it("rewrites handbook paths to docs routes", () => {
    expect(resolveHandbookHref("02-your-account.md#trust-tiers", "how-scholium-works")).toBe(
      "/docs/your-account#trust-tiers",
    );
    expect(resolveHandbookHref("04-checking-a-paper-is-genuine.md", "your-account")).toBe(
      "/docs/checking-a-paper-is-genuine",
    );
    expect(resolveHandbookHref("#recover-a-lost-account", "your-account")).toBe(
      "/docs/your-account#recover-a-lost-account",
    );
    expect(resolveHandbookHref("README.md", "your-account")).toBe("/docs");
  });

  it("leaves absolute links alone and rejects pages the docs do not serve", () => {
    expect(resolveHandbookHref("https://example.com/paper", "your-account")).toBe(
      "https://example.com/paper",
    );
    expect(resolveHandbookHref("http://example.com", "your-account")).toBe("http://example.com");
    expect(resolveHandbookHref("../deploy.md", "your-account")).toBeNull();
    expect(resolveHandbookHref("notes.md", "your-account")).toBeNull();
  });

  it("resolves every internal link in every chapter and in README.md", () => {
    const broken: string[] = [];

    const check = (markdown: string, fromSlug: string, source: string) => {
      for (const href of links(markdown)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
        if (href.startsWith("/")) continue;

        const resolved = resolveHandbookHref(href, fromSlug);

        // `../deploy.md` deliberately points outside the handbook; it must not
        // silently turn into a docs route.
        if (href.startsWith("../")) {
          if (resolved !== null) {
            broken.push(`${source}: ${href} must stay outside the docs, got ${resolved}`);
          }
          continue;
        }

        if (resolved === null) {
          broken.push(`${source}: ${href} does not resolve to a docs page`);
          continue;
        }

        const target = parseDocsHref(resolved);
        if (target === null) {
          broken.push(`${source}: ${href} resolved to an unknown route ${resolved}`);
          continue;
        }

        if (target.slug !== null) {
          const chapter = getChapter(target.slug);
          if (!chapter) {
            broken.push(`${source}: ${href} names no chapter (${resolved})`);
            continue;
          }
          if (
            target.anchor !== null &&
            !chapter.headings.some((heading) => heading.id === target.anchor)
          ) {
            broken.push(
              `${source}: ${href} names no heading ${target.anchor} in ${target.slug}`,
            );
          }
          continue;
        }

        if (target.anchor !== null && !anchorsOf(README).includes(target.anchor)) {
          broken.push(`${source}: ${href} names no heading ${target.anchor} in README.md`);
        }
      }
    };

    for (const chapter of chapters) {
      check(chapter.body, chapter.slug, `${chapter.slug}.md`);
    }
    check(README, "readme", "README.md");

    expect(broken, `Broken handbook links:\n${broken.join("\n")}`).toEqual([]);
  });
});

describe("README.md", () => {
  it("returns the Quick start by role sections and their steps", () => {
    expect(quickStartByRole.map((section) => section.title)).toEqual([
      "I want to read papers",
      "I want to publish my first paper",
      "A colleague listed me as a co-author",
      "I am a reviewer",
      "I am a moderator",
      "I lost my device",
    ]);
    // Five sections are numbered steps; "I lost my device" is a paragraph.
    expect(quickStartByRole.filter((section) => section.steps.length > 0).length).toBe(5);
    for (const section of quickStartByRole) {
      for (const step of section.steps) expect(step.trim().length).toBeGreaterThan(0);
    }
    expect(quickStartByRole[0].steps[0]).toContain("Open **Papers**");
    expect(quickStartByRole[0].steps[4]).toContain("Use **Cite** for BibTeX or RIS");
    expect(quickStartByRole[5].title).toBe("I lost my device");
    expect(quickStartByRole[5].steps).toEqual([]);
  });
});

describe("screenshots.json", () => {
  it("names a heading that exists in its chapter, from a file in public/", () => {
    const problems: string[] = [];
    for (const chapter of chapters) {
      for (const screenshot of chapter.screenshots) {
        if (!chapter.headings.some((heading) => heading.text === screenshot.heading)) {
          problems.push(
            `${chapter.slug}: screenshot ${screenshot.src} names heading "${screenshot.heading}", which is not a ## or ### heading of the chapter`,
          );
        }
        const file = path.join(PUBLIC_DIR, screenshot.src.replace(/^\//, ""));
        if (!existsSync(file)) {
          problems.push(`${chapter.slug}: screenshot file ${screenshot.src} is missing from apps/web/public`);
        }
      }
    }
    expect(problems, `Screenshot problems:\n${problems.join("\n")}`).toEqual([]);
  });

  it("belongs to the chapter it is filed under", () => {
    for (const chapter of chapters) {
      const key = String(chapter.number).padStart(2, "0");
      expect(chapter.screenshots).toEqual(SCREENSHOTS[key] ?? []);
    }
  });
});

describe("videos.json", () => {
  /** The URL forms the chapter video player knows how to embed. */
  const YOUTUBE =
    /^https?:\/\/(?:(?:www|m)\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]+/;

  it("accepts a watch, youtu.be, embed or shorts URL and nothing else", () => {
    expect(YOUTUBE.test("")).toBe(false);
    expect(YOUTUBE.test("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(YOUTUBE.test("https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s")).toBe(true);
    expect(YOUTUBE.test("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(YOUTUBE.test("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(true);
    expect(YOUTUBE.test("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
    expect(YOUTUBE.test("https://vimeo.com/12345")).toBe(false);
    expect(YOUTUBE.test("https://example.com/youtube.com/watch?v=x")).toBe(false);
  });

  it("gives every chapter a video whose poster exists", () => {
    const problems: string[] = [];
    const keys = Object.keys(VIDEOS).sort();
    expect(keys).toEqual(chapters.map((chapter) => String(chapter.number).padStart(2, "0")));

    for (const chapter of chapters) {
      const video = chapter.video;
      if (video === null) {
        problems.push(`${chapter.slug}: no entry in videos.json`);
        continue;
      }
      const poster = path.join(PUBLIC_DIR, video.poster.src.replace(/^\//, ""));
      if (!existsSync(poster)) {
        problems.push(`${chapter.slug}: poster ${video.poster.src} is missing from apps/web/public`);
      }
      if (video.youtube !== "" && !YOUTUBE.test(video.youtube)) {
        problems.push(
          `${chapter.slug}: youtube value "${video.youtube}" is not a watch, youtu.be, embed or shorts URL`,
        );
      }
    }
    expect(problems, `Video problems:\n${problems.join("\n")}`).toEqual([]);
  });

  it("belongs to the chapter it is filed under", () => {
    for (const chapter of chapters) {
      const key = String(chapter.number).padStart(2, "0");
      expect(chapter.video).toEqual(VIDEOS[key]);
    }
  });
});
