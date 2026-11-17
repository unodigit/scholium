import type { Metadata } from "next";

import {
  DECISION_BANNER_SPECS,
  DECISION_KINDS,
} from "../../../../features/ui-kit";
import { DecisionBannerDemo } from "./decision-banner-demo";

export const metadata: Metadata = {
  title: "Decision banner · UI kit",
  description:
    "Full-width banners for Retracted, Corrected, A newer version exists and Content removed for legal reasons — each linking to the record and the policy clause.",
  robots: { index: false, follow: false },
};

/**
 * `/ui-kit/decision-banner` — the four variants of docs/design.md §5.2,
 * the links every one of them carries (§7, principle 6), and the dark and
 * no-colour checks.
 */
export default function DecisionBannerGalleryPage() {
  return (
    <>
      <header className="uk-header">
        <p className="uk-crumb">ui-kit / decision-banner</p>
        <h1>Decision banner</h1>
        <p className="uk-lede">
          Full width, above the title. Every decision shows its reason: the
          banner always links to the record behind it, cites the policy
          clause when it has one, and says what the decision was in plain
          words.
        </p>
      </header>

      <section className="uk-section" aria-labelledby="variants">
        <h2 id="variants">Variants</h2>
        <table className="uk-table">
          <thead>
            <tr>
              <th scope="col">Banner</th>
              <th scope="col">
                <code>kind</code>
              </th>
              <th scope="col">Tone</th>
              <th scope="col">Shown when</th>
            </tr>
          </thead>
          <tbody>
            {DECISION_KINDS.map((kind) => {
              const spec = DECISION_BANNER_SPECS[kind];
              return (
                <tr key={kind}>
                  <td>{spec.label}</td>
                  <td>
                    <code>{kind}</code>
                  </td>
                  <td>{spec.tone}</td>
                  <td>{spec.meaning}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="uk-section" aria-labelledby="examples">
        <h2 id="examples">Examples</h2>
        <DecisionBannerDemo />
      </section>

      <section className="uk-section" aria-labelledby="links">
        <h2 id="links">The links every banner carries</h2>
        <p className="uk-note">
          Principle 6: every decision shows its reason, and the reason is
          checkable. A banner without a record renders nothing — an
          unverifiable claim is the one thing it must not show.
        </p>
        <table className="uk-table">
          <thead>
            <tr>
              <th scope="col">Link</th>
              <th scope="col">Goes to</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>View record</td>
              <td>
                The raw signed JSON of the decision&rsquo;s envelope,{" "}
                <code>GET /v1/records/&#123;cid&#125;</code>, in the record
                link&rsquo;s side sheet.
              </td>
            </tr>
            <tr>
              <td>Policy MOD-05</td>
              <td>
                The cited clause on <code>/policies#MOD-05</code>, through{" "}
                <code>policyHref</code>, so the anchor can never disagree
                with the page. Absent when the decision cites no clause.
              </td>
            </tr>
            <tr>
              <td>Go to v3</td>
              <td>
                The newer version, on the <code>newer_version</code> banner
                only; the notice is about versions, not moderation.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="uk-section" aria-labelledby="where">
        <h2 id="where">Where it appears</h2>
        <ul className="uk-list">
          <li>
            Above the title on every version of a paper — a retraction or
            correction is carried by every version, not only the newest
            (docs/design.md §11).
          </li>
          <li>In search results and citations exports, with the same words.</li>
          <li>
            Where the content itself is gone, the banner is the page: the
            tombstone sentence keeps the record&rsquo;s existence visible
            (§8).
          </li>
        </ul>
      </section>

      <section className="uk-section" aria-labelledby="accessibility">
        <h2 id="accessibility">Accessibility</h2>
        <ul className="uk-list">
          <li>
            Never colour alone: each kind has its own word and its own icon
            silhouette; tone only reinforces (§9).
          </li>
          <li>
            The banner is ordinary content — no live region, no tab stop. It
            is on the page from the first paint, and the paper&rsquo;s own
            heading remains the structural heading.
          </li>
          <li>
            Links are text, at least 44 px on touch, with the global focus
            ring; the word and sentence pass 4.5:1 on every tone fill, in
            light and dark.
          </li>
        </ul>
      </section>
    </>
  );
}
