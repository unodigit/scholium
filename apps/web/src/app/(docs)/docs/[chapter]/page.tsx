import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ChapterPage } from "../../../../features/docs/chapter-page";
import { chapters, getChapter } from "../../../../features/docs/handbook";
import { HandbookMarkdown } from "../../../../features/docs/markdown";
import { loadTranscript } from "../../../../features/docs/transcript";
import { resolveSiteUrl } from "../../../site-metadata";

/**
 * `/docs/{slug}` — one chapter of the handbook.
 *
 * The handbook is fixed at build time: its Markdown lives in `docs/handbook/`
 * and `features/docs/handbook.ts` reads it when Next.js imports the module.
 * `generateStaticParams` therefore lists every chapter, and `dynamicParams =
 * false` makes any other slug a 404 rather than a server render — there is no
 * chapter that is not on the list.
 *
 * The Markdown body is rendered here, on the server, and handed to the page
 * component as children. Only plain data (the title, the headings, the video
 * entry and the transcript's paragraphs) crosses into the client component.
 *
 * The metadata names the chapter: "{chapter title} · Docs", which the root
 * layout's "%s · Scholium" template completes as "… · Docs · Scholium" (the
 * docs home is "Docs · Scholium"), the README summary as the description, and the chapter's own URL as
 * the canonical address.
 */

/** Only the 11 chapters exist: anything else is not found, not rendered. */
export const dynamicParams = false;

interface ChapterRouteProps {
  /** Next.js hands the route params to the page as a promise. */
  params: Promise<{ chapter: string }>;
}

/** Every chapter slug, in number order. */
export function generateStaticParams(): { chapter: string }[] {
  return chapters.map((chapter) => ({ chapter: chapter.slug }));
}

/** The chapter's title, summary and canonical URL. */
export async function generateMetadata({
  params,
}: ChapterRouteProps): Promise<Metadata> {
  const chapter = getChapter((await params).chapter);
  if (chapter === undefined) notFound();

  return {
    title: `${chapter.title} · Docs`,
    description: chapter.summary,
    alternates: {
      canonical: `${resolveSiteUrl()}${chapter.href}`,
    },
  };
}

/** One chapter page, statically generated for each handbook chapter. */
export default async function ChapterRoutePage({ params }: ChapterRouteProps) {
  const { chapter: slug } = await params;
  const chapter = getChapter(slug);
  if (chapter === undefined) notFound();

  const index = chapters.findIndex((item) => item.slug === chapter.slug);
  const previous = index > 0 ? chapters[index - 1] : null;
  const next = index < chapters.length - 1 ? chapters[index + 1] : null;
  const transcript =
    chapter.video === null ? [] : loadTranscript(chapter.video.transcript);

  return (
    <ChapterPage
      number={chapter.number}
      title={chapter.title}
      summary={chapter.summary}
      headings={chapter.headings}
      video={chapter.video}
      transcript={transcript}
      previous={
        previous === null ? null : { title: previous.title, href: previous.href }
      }
      next={next === null ? null : { title: next.title, href: next.href }}
    >
      <HandbookMarkdown chapter={chapter} />
    </ChapterPage>
  );
}
