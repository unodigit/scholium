import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The handbook, loaded from `docs/handbook/` when the web app is built.
 *
 * The Markdown in `docs/handbook/` is the single source of the docs text:
 * nothing is copied into the app. The files are read when Next.js imports this
 * module to statically generate the docs pages (`next build`), never in a
 * browser, so the pages are plain HTML afterwards.
 *
 * The directory is resolved from the `apps/web` directory as
 * `../../docs/handbook` (the process working directory during `next build`).
 * The other candidates only keep the module usable from the repository root
 * and from the Vitest process.
 */
function locateHandbookDir(): string {
  const candidates = [
    // The normal case: `npm run build` / vitest run with apps/web as the cwd.
    path.resolve(/*turbopackIgnore: true*/ process.cwd(), "../../docs/handbook"),
    // `npm test` from the repository root.
    path.resolve(/*turbopackIgnore: true*/ process.cwd(), "docs/handbook"),
  ];
  // Anywhere below the repository root, e.g. a test run from a nested folder.
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    candidates.push(path.join(/*turbopackIgnore: true*/ dir, "docs/handbook"));
    if (path.dirname(dir) === dir) break;
  }
  try {
    // Resolving from this source file: docs -> features -> src -> apps/web.
    candidates.push(
      path.resolve(/*turbopackIgnore: true*/ path.dirname(fileURLToPath(import.meta.url)), "../../../../../docs/handbook"),
    );
  } catch {
    // A bundle may replace import.meta.url; the cwd candidates already cover it.
  }
  for (const candidate of candidates) {
    if (existsSync(/*turbopackIgnore: true*/ path.join(candidate, "README.md"))) return candidate;
  }
  throw new Error(
    `Cannot find docs/handbook (looked in ${candidates.join(", ")}). ` +
      "The docs pages must be built from the handbook at the repository root.",
  );
}

/** Absolute path to `docs/handbook/`; exported for the tests. */
export const HANDBOOK_DIR = locateHandbookDir();

/** A heading from a chapter body, with the id a GitHub-rendered page gives it. */
export type HandbookHeading = {
  /** `##` is 2, `###` is 3. */
  level: 2 | 3;
  /** The heading text with its Markdown markers, e.g. `Step 1: Files`. */
  text: string;
  /** The anchor id, e.g. `step-1-files`. */
  id: string;
};

/** One curated screenshot, as recorded in `docs/handbook/screenshots.json`. */
export type HandbookScreenshot = {
  /** Public URL under `apps/web/public`, e.g. `/docs/screenshots/ch01-….webp`. */
  src: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  /** The chapter heading the screenshot belongs directly after. */
  heading: string;
  /** The capture it was made from, kept for provenance. */
  source: string;
};

/** One chapter's video, as recorded in `docs/handbook/videos.json`. */
export type HandbookVideo = {
  /** Empty until the owner uploads the video. */
  youtube: string;
  duration_seconds: number;
  poster: { src: string; width: number; height: number };
  /** WebVTT file relative to `docs/handbook/`. */
  transcript: string;
};

/** One chapter of the handbook. */
export type HandbookChapter = {
  /** 1 to 11, from the file name. */
  number: number;
  /** The file name without `NN-` and `.md`, e.g. `your-account`. */
  slug: string;
  /**
   * The `# ` heading without its leading `N. ` number, e.g. `Your account`.
   * The number is exposed separately, the same way the handbook's own build
   * script and README chapter table treat it.
   */
  title: string;
  /** The raw `# ` heading text, e.g. `2. Your account`. */
  heading: string;
  /** The "Read it if you want to…" column of README.md's chapter table. */
  summary: string;
  /** The Markdown after the title line, rendered by the docs page. */
  body: string;
  /** The route of the chapter's page. */
  href: string;
  /** `##` and `###` headings in document order, with their GitHub anchors. */
  headings: HandbookHeading[];
  /** Curated screenshots in reading order; empty for chapters 10 and 11. */
  screenshots: HandbookScreenshot[];
  /** The chapter's video entry, or null when videos.json has none. */
  video: HandbookVideo | null;
};

/** One "Quick start by role" section of README.md. */
export type QuickStartSection = {
  /** The `###` heading, e.g. `I want to publish my first paper`. */
  title: string;
  /** Each ordered-list item's Markdown, without its `1.` marker. */
  steps: string[];
};

const CHAPTER_FILE = /^(\d+)-(.+)\.md$/;

function read(file: string): string {
  return readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ HANDBOOK_DIR, file), "utf8").replace(/\r\n?/g, "\n");
}

/** Remove inline Markdown markers so an anchor is made from the visible text. */
function visibleHeadingText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_`]/g, "");
}

/**
 * The anchor GitHub generates for a heading: lower case, punctuation removed,
 * spaces turned into hyphens (`If you are someone's guardian` →
 * `if-you-are-someones-guardian`).
 */
export function githubAnchor(text: string): string {
  return visibleHeadingText(text)
    .trim()
    .toLowerCase()
    .replace(/<[!/a-z].*?>/g, "")
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * The anchors for a sequence of headings, in document order. A heading whose
 * anchor is already taken gets `-1`, then `-2`, as GitHub does.
 */
export function headingAnchors(texts: readonly string[]): string[] {
  const taken = new Set<string>();
  return texts.map((text) => {
    const base = githubAnchor(text);
    let anchor = base;
    let suffix = 0;
    while (taken.has(anchor)) {
      suffix += 1;
      anchor = `${base}-${suffix}`;
    }
    taken.add(anchor);
    return anchor;
  });
}

type RawHeading = { level: number; text: string };

/** Every ATX heading in a Markdown string, ignoring fenced code blocks. */
function scanHeadings(markdown: string): RawHeading[] {
  const headings: RawHeading[] = [];
  let fence: "`" | "~" | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    headings.push({
      level: match[1].length,
      text: match[2].replace(/\s+#+\s*$/, "").trim(),
    });
  }
  return headings;
}

/** Split a chapter file into its `# ` title and the Markdown body below it. */
function splitTitle(markdown: string): { heading: string; title: string; body: string } {
  const lines = markdown.split("\n");
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (titleIndex === -1) throw new Error("a handbook chapter has no '# ' title");
  const heading = lines[titleIndex].replace(/^#\s+/, "").trim();
  // The number is part of the file name and exposed separately.
  const title = heading.replace(/^\d+\.\s+/, "");
  const bodyLines = lines.slice(titleIndex + 1);
  while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
  return { heading, title, body: bodyLines.join("\n").trimEnd() };
}

/** The summary column of README.md's chapter table, keyed by chapter file. */
function chapterSummaries(readme: string): Map<string, string> {
  const summaries = new Map<string, string>();
  for (const line of readme.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const link = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(cells[1]);
    if (!link) continue;
    const file = link[2].split("#")[0];
    if (!CHAPTER_FILE.test(file)) continue;
    summaries.set(file, cells[2]);
  }
  return summaries;
}

/** The ordered-list steps in one section of README.md. */
function parseSteps(lines: readonly string[]): string[] {
  const steps: string[] = [];
  let inList = false;
  for (const line of lines) {
    const item = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (item) {
      steps.push(item[1].trim());
      inList = true;
      continue;
    }
    if (!line.trim() || !/^\s+/.test(line)) {
      inList = false;
      continue;
    }
    if (inList && steps.length > 0) {
      steps[steps.length - 1] += ` ${line.trim()}`;
    }
  }
  return steps;
}

/** README.md's "Quick start by role" sections: each `###` title and its list. */
function parseQuickStart(readme: string): QuickStartSection[] {
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^##\s+Quick start by role\s*$/.test(line));
  if (start === -1) return [];

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const sections: QuickStartSection[] = [];
  let title: string | null = null;
  let sectionLines: string[] = [];
  const finish = () => {
    if (title === null) return;
    sections.push({ title, steps: parseSteps(sectionLines) });
  };
  for (const line of lines.slice(start + 1, end)) {
    const heading = /^###\s+(.*?)\s*$/.exec(line);
    if (heading) {
      finish();
      title = heading[1];
      sectionLines = [];
    } else if (title !== null) {
      sectionLines.push(line);
    }
  }
  finish();
  return sections;
}

function readJson<T>(file: string): T {
  return JSON.parse(read(file)) as T;
}

/** `"01"` for chapter 1, the keys videos.json and screenshots.json use. */
function chapterKey(number: number): string {
  return String(number).padStart(2, "0");
}

function loadChapters(): HandbookChapter[] {
  const readme = read("README.md");
  const summaries = chapterSummaries(readme);
  const screenshots = readJson<Record<string, HandbookScreenshot[]>>("screenshots.json");
  const videos = readJson<Record<string, HandbookVideo>>("videos.json");

  const files = readdirSync(/*turbopackIgnore: true*/ HANDBOOK_DIR)
    .map((file) => ({ file, match: CHAPTER_FILE.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));

  return files.map(({ file, match }) => {
    const number = Number(match[1]);
    const slug = match[2];
    const { heading, title, body } = splitTitle(read(file));

    // Anchors are numbered across the whole file, the title heading included,
    // because that is the document the chapter's links were written against.
    const scanned = scanHeadings(body);
    const anchors = headingAnchors([heading, ...scanned.map((item) => item.text)]);
    const headings: HandbookHeading[] = scanned
      .map((item, index) => ({
        level: item.level,
        text: item.text,
        id: anchors[index + 1],
      }))
      .filter(
        (item): item is HandbookHeading => item.level === 2 || item.level === 3,
      );

    const key = chapterKey(number);
    return {
      number,
      slug,
      title,
      heading,
      summary: summaries.get(file) ?? "",
      body,
      href: chapterHref(slug),
      headings,
      screenshots: screenshots[key] ?? [],
      video: videos[key] ?? null,
    };
  });
}

/** The route of a chapter's docs page, e.g. `/docs/your-account`. */
export function chapterHref(slug: string): string {
  return `/docs/${slug}`;
}

/**
 * Rewrite a link written for the repository to the docs route that serves it.
 *
 * - `NN-slug.md#anchor` → `/docs/slug#anchor`
 * - `#anchor` → `/docs/{fromSlug}#anchor` (the same chapter)
 * - `README.md` → `/docs`
 * - `http(s)` and other absolute URLs are returned unchanged
 * - anything else relative (`../deploy.md`, an unknown file) → null, because
 *   the docs do not serve it; the caller renders it as plain text.
 */
export function resolveHandbookHref(href: string, fromSlug: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "") return null;

  // Absolute URLs (http, https, mailto, …) and root-relative app paths are
  // already usable as they are.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) return trimmed;

  const hashIndex = trimmed.indexOf("#");
  const file = (hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)).trim();
  const fragment = hashIndex === -1 ? "" : trimmed.slice(hashIndex + 1).trim();
  const suffix = fragment ? `#${fragment}` : "";

  if (file === "") {
    // An anchor on its own belongs to the page being rendered. The docs home
    // renders README.md, so its anchors stay on /docs.
    const base =
      fromSlug === "" || /^readme(\.md)?$/i.test(fromSlug)
        ? "/docs"
        : chapterHref(fromSlug);
    return `${base}${suffix}`;
  }
  if (file === "README.md" || file === "./README.md") {
    return fragment ? `/docs#${fragment}` : "/docs";
  }

  const chapter = CHAPTER_FILE.exec(file);
  if (!chapter) return null;
  return `${chapterHref(chapter[2])}${suffix}`;
}

/** The 11 chapters, in number order. */
export const chapters: HandbookChapter[] = loadChapters();

/** Alias for `chapters`, for callers that prefer the explicit name. */
export const handbookChapters: HandbookChapter[] = chapters;

/** README.md's "Quick start by role" sections, in reading order. */
export const quickStartByRole: QuickStartSection[] = parseQuickStart(read("README.md"));

/** Alias for `quickStartByRole`. */
export const quickStarts: QuickStartSection[] = quickStartByRole;

/** The chapter with this slug, or undefined when there is none. */
export function getChapter(slug: string): HandbookChapter | undefined {
  return chapters.find((chapter) => chapter.slug === slug);
}

/** Alias for `getChapter`. */
export const findChapter = getChapter;
