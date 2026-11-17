import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

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

/**
 * The category's first page, read once per request: the title and the page
 * must reach the same verdict on whether the category exists, and Next runs
 * `generateMetadata` and the page separately. A failed read is a message, not
 * a throw — the page shows it and the title simply cannot tell.
 */
const loadFirstPage = cache(
  async (category: string): Promise<{ page?: FeedPageData; error?: string }> => {
    try {
      return { page: await loadFeedPage(categoryFeedState(category)) };
    } catch (error) {
      return { error: describeFeedError(error, "latest") };
    }
  },
);

/**
 * A code the node's taxonomy does not name and that no listed paper is filed
 * under is not a category: it is a mistyped or invented URL. Unknown only
 * when the listing was read and came back empty; an unreadable listing says
 * nothing either way.
 */
function isInventedCategory(category: string, page: FeedPageData | undefined): boolean {
  return (
    page !== undefined && page.items.length === 0 && categoryLabel(category) === null
  );
}

/**
 * The page title names the category and its human label (`cs.AI · Artificial
 * Intelligence`). An invented category answers 404 here too, so its tab is
 * titled by the not-found page ("Not found · Scholium") rather than naming a
 * category that does not exist.
 */
export async function generateMetadata({
  params,
}: CategoryRouteProps): Promise<Metadata> {
  const category = normalizeCategory((await params).category);
  if (category === "") {
    return {
      title: "Category",
      description: "Papers by category on Scholium.",
    };
  }
  const label = categoryLabel(category);
  // A category the taxonomy names exists whether or not it has papers yet, so
  // only an unnamed one needs the listing read to be told apart.
  if (label === null && isInventedCategory(category, (await loadFirstPage(category)).page)) {
    notFound();
  }
  return {
    title: `${label === null ? category : `${category} · ${label}`}`,
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

  const { page: initialPage, error: initialError } = await loadFirstPage(category);

  // Answer an invented category with the app's not-found page rather than an
  // empty category and an Atom link that can never carry anything. A category
  // that has papers still renders even when the launch taxonomy does not name
  // it, and a category the taxonomy knows keeps its honest empty state.
  if (isInventedCategory(category, initialPage)) {
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
