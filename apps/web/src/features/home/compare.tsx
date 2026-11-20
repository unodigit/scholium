"use client";

import { useReveal } from "./reveal";
import { Icon } from "./icons";
import "./home.css";
import "./closing.css";

/**
 * #compare — "Same free preprints. A record you can check."
 * (docs/homepage/index.html). A semantic table: sr-only caption, scoped row
 * headers, the two named columns, the Scholium column tinted with a check
 * icon per cell. Under 720px the thead is dropped and each row becomes a
 * labelled two-column card (closing.css reads the `data-label`s).
 */

interface CompareRow {
  readonly label: string;
  readonly typical: string;
  readonly scholium: string;
}

const ROWS: readonly CompareRow[] = [
  {
    label: "Proof of authorship",
    typical: "The operator's database",
    scholium: "The authors' own signatures, checkable offline",
  },
  {
    label: "Proof of what changed",
    typical: "A version list the operator keeps",
    scholium: "Each version records the fingerprint of the one before",
  },
  {
    label: "Peer review",
    typical: "Elsewhere, usually closed",
    scholium: "Beside the paper, structured, readable by anyone",
  },
  {
    label: "AI assistance",
    typical: "None, or unlabelled",
    scholium: "Advisory pre-review, clearly labelled, with evidence links",
  },
  {
    label: "Corrections",
    typical: "A replaced file",
    scholium: "A signed record and a banner on every version",
  },
  {
    label: "Taking your work elsewhere",
    typical: "Download the PDF",
    scholium: "Export a full archive that verifies without us",
  },
  {
    label: "Cost",
    typical: "Usually free",
    scholium: "Free to read and to publish",
  },
];

export function CompareSection() {
  const head = useReveal<HTMLElement>();
  const table = useReveal<HTMLDivElement>();

  return (
    <section className="section" id="compare" aria-labelledby="compare-title">
      <div className="wrap">
        <header className="sec-head reveal" ref={head}>
          <p className="eyebrow">How Scholium compares</p>
          <h2 id="compare-title" className="title">
            Same free preprints. A record you can check.
          </h2>
          <p className="lead">Scholium works alongside the preprint servers you already use. Here is what it adds.</p>
        </header>
        <div className="compare-wrap reveal" ref={table}>
          <table className="compare">
            <caption className="sr-only">How Scholium compares with a typical preprint server</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Question</span>
                </th>
                <th scope="col">A typical preprint server</th>
                <th scope="col" className="us">
                  Scholium
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td data-label="Typical">{row.typical}</td>
                  <td className="us" data-label="Scholium">
                    <Icon name="check" />
                    {row.scholium}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export default CompareSection;
