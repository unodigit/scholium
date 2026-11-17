import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  CategoryPage,
  categoryDescription,
  categoryFeedHref,
  categoryFeedState,
  categoryLabel,
  describeFeedError,
  loadFeedPage,
  normalizeCategory,
  type FeedPageData,
} from "../../../../features/feed";

/** The category's papers are live API data; nothing useful can be prerendered. */
export const dynamic = "force-dynamic";

interface CategoryRouteProps {
  /** Next.js 15 hands the route params to the page as a promise. */
  params: Promise<{ category: string }>;
}

/** The page title names the category and its human label (`cs.AI · Artificial Intelligence`). */
export async function generateMetadata({
  params,
}: CategoryRouteProps): Promise<Metadata> {
  const category = normalizeCategory((await params).category);
  if (category === "") {
    return {
      title: "Category · Scholium",
      description: "Papers by category on Scholium.",
    };
  }
  const label = categoryLabel(category);
  return {
    title: `${label === null ? category : `${category} · ${label}`} · Scholium`,
    description: categoryDescription(category),
    // Lets a feed reader discover the category's Atom feed from the page.
    alternates: {
      types: { "application/atom+xml": categoryFeedHref(category) },
    },
  };
}

/**
 * `/c/{category}` — the category's newest papers, rendered on the server.
 *
 * The first page comes from the same `GET /v1/papers` listing the home feed
 * reads, narrowed with `category=…`, so the first HTML response already holds
 * the rows and the page works without JavaScript. A failed fetch is a
 * retryable message, not a throw: the heading and the Atom feed link stay.
 *
 * The Atom feed itself is served by the API at `/v1/feeds/{category}`; this
 * page only links to it.
 */
export default async function CategoryRoutePage({ params }: CategoryRouteProps) {
  const raw = (await params).category;
  const category = normalizeCategory(raw);

  if (category === "") {
    return (
      <CategoryPage
        category={String(raw).slice(0, 64)}
        error="That is not a category on this node."
        feedHref={null}
      />
    );
  }

  let initialPage: FeedPageData | undefined;
  let initialError: string | undefined;

  try {
    initialPage = await loadFeedPage(categoryFeedState(category));
  } catch (error) {
    initialError = describeFeedError(error, "latest");
  }

  // A code the node's taxonomy does not name and that no listed paper is
  // filed under is not a category: it is a mistyped or invented URL. Answer
  // with the app's not-found page rather than an empty category and an Atom
  // link that can never carry anything. A category that has papers still
  // renders even when the launch taxonomy does not name it, and a category
  // the taxonomy knows keeps its honest empty state.
  if (
    initialPage !== undefined &&
    initialPage.items.length === 0 &&
    categoryLabel(category) === null
  ) {
    notFound();
  }

  return (
    <CategoryPage
      category={category}
      items={initialPage?.items}
      error={initialError}
      feedHref={categoryFeedHref(category)}
    />
  );
}
