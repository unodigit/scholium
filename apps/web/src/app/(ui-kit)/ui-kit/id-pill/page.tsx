import type { Metadata } from "next";

import { IdPillDemo } from "./id-pill-demo";

export const metadata: Metadata = {
  title: "ID pill · UI kit",
  description:
    "A sch: id in monospace that copies on click and confirms with a “Copied” toast.",
  robots: { index: false, follow: false },
};

/**
 * `/ui-kit/id-pill` — the pill in a feed row, in a sentence, in a narrow
 * column and in the dark theme, with what a click does and how it is read out.
 */
export default function IdPillGalleryPage() {
  return (
    <>
      <header className="uk-header">
        <p className="uk-crumb">ui-kit / id-pill</p>
        <h1>ID pill</h1>
        <p className="uk-lede">
          A <code>sch:</code> id in monospace, always copyable (docs/design.md
          §2). Click it: the id goes to the clipboard and a &ldquo;Copied&rdquo;
          toast confirms it. Pass the whole id, <code>sch:</code> included; the
          pill shows and copies exactly that string.
        </p>
      </header>

      <section className="uk-section" aria-labelledby="examples">
        <h2 id="examples">Examples</h2>
        <IdPillDemo />
      </section>

      <section className="uk-section" aria-labelledby="behaviour">
        <h2 id="behaviour">Behaviour</h2>
        <table className="uk-table">
          <thead>
            <tr>
              <th scope="col">Moment</th>
              <th scope="col">What the reader sees</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>At rest</td>
              <td>The id and a copy glyph, in a quiet hairline pill.</td>
            </tr>
            <tr>
              <td>Copied</td>
              <td>
                The toast &ldquo;Copied&rdquo; for two seconds, and the glyph
                becomes a tick for the same two.
              </td>
            </tr>
            <tr>
              <td>Refused by the browser</td>
              <td>
                The toast &ldquo;Couldn&rsquo;t copy&rdquo;. The pill never says
                &ldquo;Copied&rdquo; for text that was not copied.
              </td>
            </tr>
            <tr>
              <td>Clicked again</td>
              <td>
                The toast is replaced, not stacked, and the two seconds start
                over.
              </td>
            </tr>
            <tr>
              <td>Blank id</td>
              <td>Nothing is rendered: there is nothing to copy.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="uk-section" aria-labelledby="accessibility">
        <h2 id="accessibility">Accessibility</h2>
        <ul className="uk-list">
          <li>
            The pill is a <code>&lt;button&gt;</code>, so Tab, Enter and Space
            work. Its name is &ldquo;Copy &lt;id&gt;&rdquo;, which contains the
            visible text.
          </li>
          <li>
            The toast is written into one polite{" "}
            <code>role=&quot;status&quot;</code> region that is already in the
            page before the first click, so screen readers announce it.
          </li>
          <li>
            The tick on the pill is its own confirmation for anyone who misses
            the toast. It changes shape, not just colour.
          </li>
          <li>
            Touch targets grow to 44 px on coarse pointers. The toast ignores
            the pointer, rises only when motion is welcome, and keeps its edge
            in forced-colours mode.
          </li>
          <li>
            Copying uses the Clipboard API and falls back to{" "}
            <code>execCommand</code> on a plain-HTTP node, so it works off
            localhost too.
          </li>
        </ul>
      </section>
    </>
  );
}
