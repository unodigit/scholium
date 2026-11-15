import type { Metadata } from "next";

import {
  PAPER_STATUSES,
  STATUS_CHIP_SPECS,
  StatusChip,
} from "../../../../features/ui-kit";

export const metadata: Metadata = {
  title: "Status chip · UI kit · Scholium",
  description: "Status chips: an icon plus a word, never colour alone.",
  robots: { index: false, follow: false },
};

/** One chip per status; Under review shows its reviewer count. */
function AllChips() {
  return (
    <div className="uk-chips">
      {PAPER_STATUSES.map((status) => (
        <StatusChip
          key={status}
          status={status}
          count={status === "under_review" ? 3 : undefined}
        />
      ))}
    </div>
  );
}

/**
 * `/ui-kit/status-chip` — every StatusChip variant, in context, without
 * colour, and in the dark theme.
 */
export default function StatusChipGalleryPage() {
  return (
    <>
      <header className="uk-header">
        <p className="uk-crumb">ui-kit / status-chip</p>
        <h1>Status chip</h1>
        <p className="uk-lede">
          A paper&rsquo;s standing as an icon plus a word. Colour only
          reinforces: every status has its own shape and its own word.
        </p>
      </header>

      <section className="uk-section" aria-labelledby="variants">
        <h2 id="variants">Variants</h2>
        <table className="uk-table">
          <thead>
            <tr>
              <th scope="col">Chip</th>
              <th scope="col">
                <code>status</code>
              </th>
              <th scope="col">Shown when</th>
            </tr>
          </thead>
          <tbody>
            {PAPER_STATUSES.map((status) => {
              const spec = STATUS_CHIP_SPECS[status];
              return (
                <tr key={status}>
                  <td>
                    <div className="uk-chips">
                      <StatusChip status={status} />
                      {status === "under_review" ? (
                        <StatusChip status={status} count={3} />
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <code>{status}</code>
                  </td>
                  <td>{spec.meaning}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="uk-section" aria-labelledby="in-context">
        <h2 id="in-context">In a feed row</h2>
        <article className="uk-panel uk-row">
          <h3 className="paper-title">Can a Meta-Agent Choose the Safer Branch?</h3>
          <p className="meta">M. Zhang, A. Okafor, +2 · cs.AI, cs.MA · v2 · 3 days ago</p>
          <div className="uk-chips">
            <StatusChip status="under_review" count={3} />
          </div>
        </article>
      </section>

      <section className="uk-section" aria-labelledby="no-colour">
        <h2 id="no-colour">Without colour</h2>
        <p className="uk-note">
          The same chips with every colour removed. Each is still identified by
          its icon shape and its word.
        </p>
        <div className="uk-panel uk-greyscale">
          <AllChips />
        </div>
      </section>

      <section className="uk-section" aria-labelledby="dark">
        <h2 id="dark">Dark theme</h2>
        <p className="uk-note">
          Chips read the design tokens, so a <code>data-theme=&quot;dark&quot;</code>{" "}
          subtree re-themes them without any extra classes.
        </p>
        <div className="uk-panel" data-theme="dark">
          <AllChips />
        </div>
      </section>
    </>
  );
}
