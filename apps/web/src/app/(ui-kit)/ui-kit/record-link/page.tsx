import type { Metadata } from "next";

import { RecordLinkDemo } from "./record-link-demo";

export const metadata: Metadata = {
  title: "Record link · UI kit",
  description:
    "“View record” opens the raw signed JSON from GET /v1/records/{cid} in a side sheet.",
  robots: { index: false, follow: false },
};

/**
 * `/ui-kit/record-link` — the trigger and the side sheet it opens, with the
 * record, a custom label, a missing record and the dark theme.
 */
export default function RecordLinkGalleryPage() {
  return (
    <>
      <header className="uk-header">
        <p className="uk-crumb">ui-kit / record-link</p>
        <h1>Record link</h1>
        <p className="uk-lede">
          &ldquo;View record&rdquo; opens the raw signed JSON from{" "}
          <code>GET /v1/records/&#123;cid&#125;</code> in a side sheet. The
          sheet is a modal dialog: focus moves to Close, Tab stays inside,
          Escape and Close dismiss it, and focus returns to the link.
        </p>
      </header>

      <section className="uk-section" aria-labelledby="examples">
        <h2 id="examples">Examples</h2>
        <RecordLinkDemo />
      </section>

      <section className="uk-section" aria-labelledby="behaviour">
        <h2 id="behaviour">Behaviour</h2>
        <table className="uk-table">
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">What the sheet shows</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Loading</td>
              <td>
                &ldquo;Loading record…&rdquo;, announced as a status, while{" "}
                <code>GET /v1/records/&#123;cid&#125;</code> is in flight.
              </td>
            </tr>
            <tr>
              <td>Ready</td>
              <td>
                The served envelope as pretty-printed JSON, verbatim — no
                summary, no rearranged fields.
              </td>
            </tr>
            <tr>
              <td>Not found</td>
              <td>
                &ldquo;This record is not on this server.&rdquo; plus one
                &ldquo;Try again&rdquo; action.
              </td>
            </tr>
            <tr>
              <td>Unreachable</td>
              <td>
                &ldquo;The server could not be reached. Try again.&rdquo; The
                sheet never shows a partial or stale record.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="uk-section" aria-labelledby="accessibility">
        <h2 id="accessibility">Accessibility</h2>
        <ul className="uk-list">
          <li>
            The trigger is a <code>&lt;button&gt;</code>, not a link: it opens
            a panel rather than navigating. It carries{" "}
            <code>aria-haspopup=&quot;dialog&quot;</code> and{" "}
            <code>aria-expanded</code>.
          </li>
          <li>
            The panel is <code>role=&quot;dialog&quot;</code> with{" "}
            <code>aria-modal=&quot;true&quot;</code>, labelled by its heading
            and described by the record id.
          </li>
          <li>
            The JSON is text in a <code>&lt;pre&gt;</code>, so it is readable by
            screen readers and survives forced-colours and print.
          </li>
          <li>
            The page behind the sheet does not scroll; the sheet body does, so a
            long record stays reachable.
          </li>
        </ul>
      </section>
    </>
  );
}
