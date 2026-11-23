import Link from "next/link";
import type { ReactNode } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  githubAnchor,
  resolveHandbookHref,
  type HandbookChapter,
  type HandbookHeading,
  type HandbookScreenshot,
} from "./handbook";

/**
 * A handbook chapter's Markdown, rendered for the docs pages.
 *
 * This is a server component on purpose: `./handbook` reads `docs/handbook/`
 * from disk when it is imported, so nothing here may be pulled into a client
 * bundle (no `"use client"`, no hooks, no event handlers).
 *
 * What it guarantees:
 *
 * - **No raw HTML.** There is no `rehype-raw`, so HTML written in the Markdown
 *   is shown as text and never becomes an element. `react-markdown` also drops
 *   `javascript:` URLs before a link is rendered.
 * - **Stable anchors.** Every `##` and `###` heading carries the id that
 *   `handbook.ts` computed (the one the handbook's own links were written
 *   against) and a "#" link to it, visible on hover and on keyboard focus.
 * - **Repository links become docs links.** Every link goes through
 *   `resolveHandbookHref`: a cross-chapter link is a Next `Link` to
 *   `/docs/slug#anchor`, and a path the docs do not serve (`../deploy.md`) is
 *   shown as its text with the path in code, not as a dead link.
 * - **Wide tables stay in their lane.** Each table sits in a focusable,
 *   labelled, horizontally scrollable region, so it can never widen the page.
 * - **Screenshots sit under the heading that names them**, as a figure with a
 *   caption and a link to the full-size image.
 */

/** What the renderer needs from a chapter. */
export type HandbookMarkdownChapter = Pick<
  HandbookChapter,
  "slug" | "body" | "headings" | "screenshots"
>;

export type HandbookMarkdownProps = {
  chapter: HandbookMarkdownChapter;
  /** Extra classes for the wrapping element, e.g. to set the column width. */
  className?: string;
};

/** The accessible name of every heading's "#" link. */
export const SECTION_LINK_LABEL = "Link to this section";

// ---------------------------------------------------------------------------
// hast helpers
// ---------------------------------------------------------------------------

/** The slice of a hast node the helpers read; `Element` and `Root` fit it. */
type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** Depth-first, document order. */
function walk(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** The visible text under a node. */
function textContent(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textContent).join("");
}

/**
 * Give each rendered `##` / `###` the id `handbook.ts` assigned to it.
 *
 * `react-markdown` does not slug headings, and slugging again here could
 * disagree with the ids the handbook's links point at. Each heading is paired
 * with the next entry of `headings` that has the same level and the same
 * GitHub anchor, in document order, so a repeated title gets its `-1` / `-2`
 * id. The cursor lives inside the transformer, so every render starts afresh.
 */
function rehypeHandbookHeadingIds(headings: readonly HandbookHeading[]) {
  return () => (tree: HastNode) => {
    let cursor = 0;
    walk(tree, (node) => {
      const level = node.tagName === "h2" ? 2 : node.tagName === "h3" ? 3 : 0;
      if (level === 0) return;
      const anchor = githubAnchor(textContent(node));
      for (let index = cursor; index < headings.length; index += 1) {
        const heading = headings[index];
        if (heading.level === level && githubAnchor(heading.text) === anchor) {
          node.properties = { ...node.properties, id: heading.id };
          cursor = index + 1;
          return;
        }
      }
    });
  };
}

/** The text of a table's first header cell, or "" for a table without one. */
function firstHeaderText(table: HastNode | undefined): string {
  let found = "";
  if (!table) return found;
  walk(table, (node) => {
    if (found === "" && node.tagName === "th") found = textContent(node).trim();
  });
  return found;
}

// ---------------------------------------------------------------------------
// Styles. Tailwind utilities backed by the design tokens (docs/design.md §3):
// reading text in the serif, UI text in the sans, one hairline for every edge.
// ---------------------------------------------------------------------------

const LINK_CLASS =
  "text-accent underline decoration-from-font underline-offset-[0.18em]";
const CODE_CLASS =
  "rounded-control bg-(--bg-2) px-1.5 py-0.5 font-mono text-mono [overflow-wrap:anywhere]";

/** The "#" link: hidden until the heading is hovered or something in it has focus. */
const SECTION_LINK_CLASS = [
  "ml-2 inline-flex min-h-6 min-w-6 items-center justify-center rounded-control",
  "font-sans text-ui font-medium text-ink-2 no-underline",
  "transition-opacity",
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
  // Touch screens have no hover, so the link stays visible, but quiet.
  "[@media(hover:none)]:opacity-60",
  "hover:text-accent",
].join(" ");

const HEADING_CLASS: Record<2 | 3, string> = {
  // 80 px keeps a jumped-to heading clear of the 64 px sticky navigation.
  2: "group mt-12 mb-4 scroll-mt-20 font-serif text-paper-title text-ink",
  3: "group mt-8 mb-3 scroll-mt-20 font-sans text-reading font-semibold text-ink",
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

type ElementProps = ExtraProps & { children?: ReactNode };

/** Props to pass on to a DOM element: everything except react-markdown's `node`. */
function domProps<T extends ExtraProps>({ node: _node, ...rest }: T) {
  return rest;
}

function SectionHeading({
  level,
  id,
  children,
  screenshots,
}: {
  level: 2 | 3;
  id: string | undefined;
  children: ReactNode;
  screenshots: readonly HandbookScreenshot[];
}) {
  const Tag = level === 2 ? "h2" : "h3";
  if (!id) return <Tag className={HEADING_CLASS[level]}>{children}</Tag>;

  // Ids from handbook.ts never contain "_", so this cannot collide with one.
  const titleId = `${id}_title`;
  return (
    <>
      {/* The heading is named by its text alone, not by the "#" link inside it. */}
      <Tag id={id} aria-labelledby={titleId} className={HEADING_CLASS[level]}>
        <span id={titleId}>{children}</span>
        <a href={`#${id}`} aria-label={SECTION_LINK_LABEL} className={SECTION_LINK_CLASS}>
          #
        </a>
      </Tag>
      {screenshots.map((screenshot) => (
        <ScreenshotFigure key={screenshot.src} screenshot={screenshot} />
      ))}
    </>
  );
}

/**
 * A screenshot with its caption. A plain `<img>` rather than `next/image`: the
 * files are already WebP under `public/`, the width and height reserve the
 * space so the page does not jump, and the image is lazy so the chapter's
 * later screenshots cost nothing until they are scrolled to.
 */
function ScreenshotFigure({ screenshot }: { screenshot: HandbookScreenshot }) {
  return (
    <figure className="my-6">
      <a
        href={screenshot.src}
        aria-label={`Open full-size image: ${screenshot.alt}`}
        className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-card border border-rule bg-surface"
      >
        <img
          src={screenshot.src}
          alt={screenshot.alt}
          width={screenshot.width}
          height={screenshot.height}
          loading="lazy"
          decoding="async"
          className="block h-auto max-h-[40rem] w-auto max-w-full"
        />
      </a>
      <figcaption className="mt-2 max-w-measure font-sans text-meta text-ink-2">
        {screenshot.caption}
      </figcaption>
    </figure>
  );
}

/** A link the docs do not serve: its text, with the path it pointed at in code. */
function UnservedLink({ href, children }: { href: string; children: ReactNode }) {
  if (href === "") return <>{children}</>;
  // `[../deploy.md](../deploy.md)` would otherwise print the path twice.
  if (children === href) return <code className={CODE_CLASS}>{href}</code>;
  return (
    <>
      {children} (<code className={CODE_CLASS}>{href}</code>)
    </>
  );
}

function createComponents(chapter: HandbookMarkdownChapter): Components {
  // A screenshot belongs to the first heading with its text, as handbook.test.ts
  // checks; the heading's id is what the rendered heading can be looked up by.
  const screenshotsById = new Map<string, HandbookScreenshot[]>();
  for (const screenshot of chapter.screenshots) {
    const heading = chapter.headings.find((item) => item.text === screenshot.heading);
    if (!heading) continue;
    screenshotsById.set(heading.id, [...(screenshotsById.get(heading.id) ?? []), screenshot]);
  }

  const heading =
    (level: 2 | 3) =>
    ({ id, children }: ElementProps & { id?: string }) => (
      <SectionHeading level={level} id={id} screenshots={screenshotsById.get(id ?? "") ?? []}>
        {children}
      </SectionHeading>
    );

  return {
    h2: heading(2),
    h3: heading(3),
    h4: ({ children }) => (
      <h4 className="mt-6 mb-2 font-sans text-ui font-semibold text-ink">{children}</h4>
    ),

    a: ({ href, title, children }) => {
      const target = href === undefined ? "" : resolveHandbookHref(href, chapter.slug);
      if (target === null || target === "") {
        return <UnservedLink href={href ?? ""}>{children}</UnservedLink>;
      }
      // A path on this site is a route; anything else leaves it.
      if (target.startsWith("/") && !target.startsWith("//")) {
        return (
          <Link href={target} title={title} className={LINK_CLASS}>
            {children}
          </Link>
        );
      }
      return (
        <a href={target} title={title} rel="noopener noreferrer" className={LINK_CLASS}>
          {children}
        </a>
      );
    },

    table: ({ node, children }) => {
      const first = firstHeaderText(node);
      return (
        <div
          role="region"
          aria-label={first ? `Table: ${first}` : "Table"}
          tabIndex={0}
          className="my-6 max-w-full overflow-x-auto rounded-card border border-rule bg-surface"
        >
          <table className="w-full border-collapse text-left font-sans text-ui">{children}</table>
        </div>
      );
    },
    thead: ({ children }) => <thead className="bg-(--bg-2)">{children}</thead>,
    tr: ({ children }) => (
      <tr className="border-b border-rule last:border-b-0">{children}</tr>
    ),
    th: (props) => (
      <th scope="col" {...domProps(props)} className="px-3 py-2 align-bottom font-semibold text-ink" />
    ),
    td: (props) => <td {...domProps(props)} className="px-3 py-2 align-top text-ink" />,

    p: ({ children }) => <p className="my-4 max-w-measure">{children}</p>,
    ul: ({ children }) => (
      <ul className="my-4 max-w-measure list-disc ps-6 marker:text-ink-2">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-4 max-w-measure list-decimal ps-6 marker:text-ink-2">{children}</ol>
    ),
    li: ({ children }) => <li className="my-1 ps-1">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="my-6 max-w-measure rounded-r-card border-s-2 border-accent bg-accent-soft px-4 py-3 font-sans text-ui text-ink [&>:first-child]:mt-0 [&>:last-child]:mb-0">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-8 border-rule" />,
    code: ({ children }) => <code className={CODE_CLASS}>{children}</code>,
    pre: ({ children }) => (
      <pre className="my-6 max-w-full overflow-x-auto rounded-card border border-rule bg-(--bg-2) p-4 [&>code]:bg-transparent [&>code]:p-0 [&>code]:[overflow-wrap:normal]">
        {children}
      </pre>
    ),
    img: ({ src, alt, title }) => (
      // An image written in the Markdown itself (the curated screenshots are the
      // figures above); its size is unknown, so it only has to fit the column.
      <img
        src={typeof src === "string" ? src : undefined}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        decoding="async"
        className="my-4 h-auto max-w-full rounded-card"
      />
    ),
  };
}

/** Render one chapter's Markdown body with its screenshots. */
export function HandbookMarkdown({ chapter, className }: HandbookMarkdownProps) {
  return (
    <div className={`min-w-0 max-w-full font-serif text-reading text-ink${className ? ` ${className}` : ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHandbookHeadingIds(chapter.headings)]}
        components={createComponents(chapter)}
      >
        {chapter.body}
      </Markdown>
    </div>
  );
}

export default HandbookMarkdown;
