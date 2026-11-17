import type { Metadata } from "next";

import {
  VERIFY_BADGE_SPECS,
  VERIFY_STATES,
  VerifyBadge,
} from "../../../../features/ui-kit";
import { VerifyBadgeDemo } from "./verify-badge-demo";

export const metadata: Metadata = {
  title: "Verify badge · UI kit",
  description:
    "Verify badge: five states of a paper's proof, each an icon plus words, never colour alone.",
  robots: { index: false, follow: false },
};

/** One badge per state. */
function AllBadges() {
  return (
    <div className="uk-chips">
      {VERIFY_STATES.map((state) => (
        <VerifyBadge key={state} state={state} />
      ))}
    </div>
  );
}

/**
 * `/ui-kit/verify-badge` — every VerifyBadge state, in context, live, without
 * colour and in the dark theme, with what a click does and how it is read out.
 */
export default function VerifyBadgeGalleryPage() {
  return (
    <>
      <header className="uk-header">
        <p className="uk-crumb">ui-kit / verify-badge</p>
        <h1>Verify badge</h1>
        <p className="uk-lede">
          Whether a paper&rsquo;s proof checks out, as an icon plus words
          (docs/design.md §5.3). Five states, each with its own icon and its own
          words; colour only reinforces. It always opens the Proof tab.
        </p>
      </header>

      <section className="uk-section" aria-labelledby="states">
        <h2 id="states">States</h2>
        <table className="uk-table">
          <thead>
            <tr>
              <th scope="col">Badge</th>
              <th scope="col">
                <code>state</code>
              </th>
              <th scope="col">Shown when</th>
            </tr>
          </thead>
          <tbody>
            {VERIFY_STATES.map((state) => (
              <tr key={state}>
                <td>
                  <VerifyBadge state={state} />
                </td>
                <td>
                  <code>{state}</code>
                </td>
                <td>{VERIFY_BADGE_SPECS[state].meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="uk-section" aria-labelledby="in-context">
        <h2 id="in-context">In the margin panel</h2>
        <p className="uk-note">
          At the head of the paper page&rsquo;s 360 px margin panel
          (docs/design.md §5.2).
        </p>
        <article
          className="uk-panel uk-row"
          style={{ maxInlineSize: "var(--margin-panel)" }}
        >
          <div className="uk-chips">
            <VerifyBadge state="verified" />
          </div>
          <p className="meta">Anchored 2 Mar 2027 · Preserved 5/5 replicas</p>
        </article>
      </section>

      <section className="uk-section" aria-labelledby="live">
        <h2 id="live">Live</h2>
        <VerifyBadgeDemo />
      </section>

      <section className="uk-section" aria-labelledby="no-colour">
        <h2 id="no-colour">Without colour</h2>
        <p className="uk-note">
          The same badges with every colour removed. Each is still identified by
          its icon shape and its words.
        </p>
        <div className="uk-panel uk-greyscale">
          <AllBadges />
        </div>
      </section>

      <section className="uk-section" aria-labelledby="dark">
        <h2 id="dark">Dark theme</h2>
        <p className="uk-note">
          Badges read the design tokens, so a{" "}
          <code>data-theme=&quot;dark&quot;</code> subtree re-themes them
          without any extra classes.
        </p>
        <div className="uk-panel" data-theme="dark">
          <AllBadges />
        </div>
      </section>

      <section className="uk-section" id="proof" aria-labelledby="where">
        <h2 id="where">Where it goes</h2>
        <p className="uk-note">
          Every badge on this page links to <code>#proof</code>, which is this
          section: a stand-in for the paper page&rsquo;s Proof tab. Press one
          and the address changes to end in <code>#proof</code>.
        </p>
        <ul className="uk-list">
          <li>
            The default <code>href</code> is <code>#proof</code>. From a feed,
            pass the paper&rsquo;s path through <code>proofTabHref</code>, for
            example <code>proofTabHref(&quot;/p/k3f9-q2xz-7mwd/v2&quot;)</code>.
          </li>
          <li>
            To switch tabs without navigating, pass <code>onClick</code> and
            call <code>event.preventDefault()</code>.
          </li>
        </ul>
      </section>

      <section className="uk-section" aria-labelledby="accessibility">
        <h2 id="accessibility">Accessibility</h2>
        <ul className="uk-list">
          <li>
            The badge is a link, so Tab and Enter work. Its name is its visible
            words, and its tooltip says what the state means and where a click
            goes.
          </li>
          <li>
            The root is a polite <code>role=&quot;status&quot;</code> region.
            When the same badge changes from &ldquo;Checking&hellip;&rdquo; to a
            verdict, the new words are announced. Keep it mounted across the
            change.
          </li>
          <li>
            &ldquo;Could not check&rdquo; is grey and &ldquo;Signed &middot;
            anchor pending&rdquo; is amber. Only &ldquo;Verification
            failed&rdquo; is red: not being able to check is never shown as a
            failure.
          </li>
          <li>
            The spinner turns only when motion is welcome; under reduced motion
            the ring stands still and the words say &ldquo;Checking&hellip;&rdquo;.
            Touch targets grow to 44 px on coarse pointers, and the pill keeps
            its edge in forced-colours mode.
          </li>
        </ul>
      </section>
    </>
  );
}
