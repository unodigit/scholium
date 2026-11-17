import type { Metadata } from "next";

import { EmptyState } from "../../../../features/ui-kit";

export const metadata: Metadata = {
  title: "Empty state · UI kit",
  description: "Empty states: one sentence and one action, never a dead end.",
  robots: { index: false, follow: false },
};

/**
 * `/ui-kit/empty-state` — the same component in the places docs/design.md §7
 * says it appears, plus the dark theme and the no-colour check.
 */
export default function EmptyStateGalleryPage() {
  return (
    <>
      <header className="uk-header">
        <p className="uk-crumb">ui-kit / empty-state</p>
        <h1>Empty state</h1>
        <p className="uk-lede">
          One sentence and one action. The sentence says what is missing and
          why that is not a dead end; the action is the one way forward. There
          is no second sentence, no second button and no heading.
        </p>
      </header>

      <section className="uk-section" aria-labelledby="reviews">
        <h2 id="reviews">No reviews yet</h2>
        <EmptyState
          sentence="No reviews yet — qualified in cs.AI? Review this paper."
          action={{ label: "Review this paper", href: "/papers/sch:9f2c1a7e/review" }}
        />
      </section>

      <section className="uk-section" aria-labelledby="annotations">
        <h2 id="annotations">No annotations yet</h2>
        <EmptyState
          sentence="No annotations yet — select a paragraph and press A to add the first."
          action={{ label: "Read the paper", href: "/papers/sch:9f2c1a7e" }}
          icon="pencil"
        />
      </section>

      <section className="uk-section" aria-labelledby="feed">
        <h2 id="feed">Nothing in the feed</h2>
        <EmptyState
          sentence="Nothing here yet — follow a category to fill your feed."
          action={{ label: "Browse categories", href: "/categories" }}
        />
      </section>

      <section className="uk-section" aria-labelledby="dark">
        <h2 id="dark">Dark theme</h2>
        <p className="uk-note">
          The panel, rule and action read the design tokens, so a{" "}
          <code>data-theme=&quot;dark&quot;</code> subtree re-themes them
          without extra classes.
        </p>
        <div data-theme="dark">
          <EmptyState
            sentence="No reviews yet — qualified in cs.AI? Review this paper."
            action={{ label: "Review this paper", href: "/papers/sch:9f2c1a7e/review" }}
          />
        </div>
      </section>

      <section className="uk-section" aria-labelledby="no-colour">
        <h2 id="no-colour">Without colour</h2>
        <p className="uk-note">
          With every colour removed, the dashed panel and the underlined action
          still carry the state and the way forward.
        </p>
        <div className="uk-greyscale">
          <EmptyState
            sentence="No reviews yet — qualified in cs.AI? Review this paper."
            action={{ label: "Review this paper", href: "/papers/sch:9f2c1a7e/review" }}
          />
        </div>
      </section>
    </>
  );
}
