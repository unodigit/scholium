import type { Metadata } from "next";
import Link from "next/link";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DocsSearch, type DocsSearchEntry } from "./docs-search";
import {
  HANDBOOK_DIR,
  chapters,
  githubAnchor,
  quickStartByRole,
  type HandbookChapter,
  type HandbookVideo,
  type QuickStartSection,
} from "./handbook";
import { HandbookMarkdown } from "./markdown";

/**
 * The docs home at `/docs`.
 *
 * Everything here is built from `docs/handbook/` when Next.js renders the page
 * at build time (`app/(docs)/docs/page.tsx`), so the first HTML response holds
 * the whole index: the "Start here" cards and all eleven chapter cards and
 * their links work with JavaScript switched off. The one client island is the
 * search field (`docs-search.tsx`), which is an enhancement over the same
 * server-rendered page.
 *
 * This is a server module: `./handbook` and `./markdown` read the handbook from
 * disk, so neither this file nor anything it imports may carry `"use client"`.
 * Only plain data crosses to the search island.
 */

/** The page description, used by the route's metadata. */
export const DOCS_DESCRIPTION =
  "How Scholium works for readers, authors, reviewers and moderators, in eleven short chapters.";

/** The route's metadata: the title "Docs" and the description above. */
export const docsHomeMetadata: Metadata = {
  title: "Docs",
  description: DOCS_DESCRIPTION,
};

/** Inline Markdown markers removed, so a heading or term reads as its text. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Chapter 11's glossary table, one entry per term. The table's first row is
 * its header (`Term | Meaning`) and the second its alignment row; every later
 * row's first cell is a term. A term links to the anchor its text would get as
 * a heading, the same anchor `handbook.ts` gives every section.
 */
function glossaryEntries(chapter: HandbookChapter): DocsSearchEntry[] {
  const entries: DocsSearchEntry[] = [];
  let headerSeen = false;

  for (const line of chapter.body.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(row)) continue; // the | --- | --- | alignment row

    const cells = row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => plainText(cell));

    if (!headerSeen) {
      headerSeen = true;
      continue;
    }

    const term = cells[0];
    if (!term) continue;
    entries.push({
      title: term,
      href: `${chapter.href}#${githubAnchor(term)}`,
      chapter: chapter.title,
    });
  }

  return entries;
}

/**
 * The searchable index, in reading order: each chapter's title, then its `##`
 * and `###` headings, and — under chapter 11 — the glossary's terms. The
 * search field filters exactly these (`docs-search.tsx`).
 */
export function buildDocsSearchIndex(): DocsSearchEntry[] {
  const entries: DocsSearchEntry[] = [];

  for (const chapter of chapters) {
    entries.push({
      title: chapter.title,
      href: chapter.href,
      chapter: chapter.title,
    });
    for (const heading of chapter.headings) {
      entries.push({
        title: plainText(heading.text),
        href: `${chapter.href}#${heading.id}`,
        chapter: chapter.title,
      });
    }
    if (chapter.number === 11) entries.push(...glossaryEntries(chapter));
  }

  return entries;
}

/**
 * A duration as a card's video line shows it: `273` is `4 min 33 s`, `300` is
 * `5 min`, `45` is `45 s`. Null when the value is not a positive number of
 * seconds.
 *
 * This repeats `chapter-video.tsx`'s formatter rather than importing it: that
 * module is a client component, and a server component may not call a function
 * exported from one. `chapter-video.test.tsx` and `formatVideoLength`'s own
 * test keep the two readings aligned.
 */
export function formatVideoLength(seconds: number): string | null {
  const total = Math.round(seconds);
  if (!Number.isFinite(total) || total < 1) return null;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * The line under a chapter card: the video's length once a video address is
 * set, and "Video coming soon" until then (the same reading as the chapter
 * page's `ChapterVideo`, which shows its coming-soon note for an empty
 * `videos.json` address).
 */
export function chapterVideoLabel(video: HandbookVideo | null): string {
  if (!video || video.youtube.trim() === "") return "Video coming soon";
  const length = formatVideoLength(video.duration_seconds);
  return length === null ? "Video coming soon" : `Video, ${length}`;
}

/** The Markdown for one "Quick start by role" card when its file text is absent. */
function stepsMarkdown(section: QuickStartSection): string {
  return section.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

/**
 * The full Markdown under each `###` heading of README.md's "Quick start by
 * role" section, keyed by the heading.
 *
 * `handbook.ts` exposes each section's ordered-list steps, but one role ("I
 * lost my device") is written as a sentence rather than a list. The cards show
 * the section as written — list or prose — so the text is taken from README.md
 * itself, read at build time like the rest of the handbook.
 */
function quickStartBodies(): Map<string, string> {
  const readme = readFileSync(path.join(HANDBOOK_DIR, "README.md"), "utf8").replace(
    /\r\n?/g,
    "\n",
  );
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^##\s+Quick start by role\s*$/.test(line));
  const bodies = new Map<string, string>();
  if (start === -1) return bodies;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  let title: string | null = null;
  let body: string[] = [];
  const finish = () => {
    if (title === null) return;
    bodies.set(title, body.join("\n").trim());
  };
  for (const line of lines.slice(start + 1, end)) {
    const heading = /^###\s+(.*?)\s*$/.exec(line);
    if (heading) {
      finish();
      title = heading[1];
      body = [];
    } else if (title !== null) {
      body.push(line);
    }
  }
  finish();

  return bodies;
}

/**
 * One "Quick start by role" card. The section's Markdown goes through the
 * docs' own renderer (`markdown.tsx`): a chapter link written for the
 * repository (`02-your-account.md#sign-in-with-a-passkey`) becomes a Next link
 * to `/docs/your-account#sign-in-with-a-passkey` with no extra work. The
 * synthetic chapter has no headings and no screenshots of its own.
 */
function RoleCard({
  section,
  body,
}: {
  section: QuickStartSection;
  body: string;
}) {
  return (
    <li className="min-w-0">
      <article className="flex h-full flex-col rounded-card border border-rule bg-surface p-4">
        <h3 className="font-sans text-ui font-semibold text-ink">
          {section.title}
        </h3>
        <div className="mt-2 min-w-0">
          <HandbookMarkdown
            chapter={{ slug: "", body, headings: [], screenshots: [] }}
            className="[&_li]:text-ui [&_p]:text-ui [&_ol]:my-2 [&_ul]:my-2 [&_p]:my-2"
          />
        </div>
      </article>
    </li>
  );
}

/**
 * One chapter card. The whole card is one destination, so it holds a single
 * link — the title — and that link's `::after` covers the card
 * (`after:absolute after:inset-0`), keeping the card clickable as a whole
 * without nesting controls (`modern-web-guidance`: "Build a Card"). The poster
 * is decorative (`alt=""`): the card already names the chapter.
 */
function ChapterCard({ chapter }: { chapter: HandbookChapter }) {
  const poster = chapter.video?.poster;

  return (
    <li className="min-w-0">
      <article className="group relative flex h-full flex-col overflow-hidden rounded-card border border-rule bg-surface transition-colors hover:border-accent has-[a:focus-visible]:border-accent">
        {poster ? (
          <img
            src={poster.src}
            alt=""
            width={poster.width}
            height={poster.height}
            loading="lazy"
            decoding="async"
            className="aspect-video w-full border-b border-rule bg-[var(--bg-2)] object-cover"
          />
        ) : null}
        <div className="flex flex-1 flex-col gap-2 p-4">
          <p className="font-sans text-meta font-medium uppercase tracking-wide text-ink-2">
            Chapter {chapter.number}
          </p>
          <h3 className="font-serif text-reading font-semibold text-ink">
            <Link
              href={chapter.href}
              className="before:absolute before:inset-0 group-hover:underline group-hover:underline-offset-[0.18em]"
            >
              {chapter.title}
            </Link>
          </h3>
          <p className="font-sans text-meta text-ink-2">{chapter.summary}</p>
          <p className="mt-auto pt-2 font-sans text-meta text-ink-2">
            {chapterVideoLabel(chapter.video)}
          </p>
        </div>
      </article>
    </li>
  );
}

/** The docs home: the H1, the search field, "Start here" and the chapters. */
export function DocsIndex() {
  const searchEntries = buildDocsSearchIndex();
  const bodies = quickStartBodies();

  return (
    <div className="min-w-0">
      <h1 className="font-serif text-paper-title font-semibold text-ink">
        Scholium docs
      </h1>
      <p className="mt-3 max-w-measure font-serif text-reading text-ink">
        {DOCS_DESCRIPTION}
      </p>

      <DocsSearch entries={searchEntries} />

      <section className="mt-10" aria-labelledby="docs-start-here">
        <h2
          id="docs-start-here"
          className="font-sans text-ui font-semibold text-ink"
        >
          Start here
        </h2>
        <ul className="mt-3 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
          {quickStartByRole.map((section) => (
            <RoleCard
              key={section.title}
              section={section}
              body={bodies.get(section.title) || stepsMarkdown(section)}
            />
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-labelledby="docs-index-chapters">
        <h2
          id="docs-index-chapters"
          className="font-sans text-ui font-semibold text-ink"
        >
          Chapters
        </h2>
        <ol className="mt-3 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
          {chapters.map((chapter) => (
            <ChapterCard key={chapter.slug} chapter={chapter} />
          ))}
        </ol>
      </section>
    </div>
  );
}

export default DocsIndex;
