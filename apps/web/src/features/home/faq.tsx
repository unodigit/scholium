"use client";

import { type ReactNode } from "react";

// Explicit extension: a bare "./faq" resolves to this very file under Next's
// bundler (Vite picks faq.ts), which made the production build fail. The
// ts-expect-error silences TS5097, which fires for any import ending in ".ts".
// @ts-expect-error "./faq.ts" needs its extension to be unambiguous
import { FAQ_ENTRIES } from "./faq.ts";
import { useReveal } from "./reveal";
import { Icon } from "./icons";
import "./home.css";
import "./closing.css";

/**
 * #faq — "Questions, answered." (docs/homepage/index.html). Eleven native
 * `details`/`summary` pairs (the questions and answers are the plain data in
 * faq.ts, so the FAQPage structured data can reuse them verbatim), each
 * question an h3 with a plus icon that turns 45 degrees on a spring when
 * open; opening animates the height where `::details-content` and
 * `interpolate-size` are supported and is instant elsewhere (closing.css).
 * Beside them, the "at a glance" card: a definition list of the reference's
 * eleven facts, sticky on desktop.
 *
 * Import note: `./faq` resolves to faq.ts (the data — that is the point of
 * the split), so this module is imported through its explicit extension,
 * `./faq.tsx`.
 */

interface GlanceFact {
  readonly term: string;
  readonly details: ReactNode;
}

const GLANCE_FACTS: readonly GlanceFact[] = [
  { term: "What it is", details: "A preprint and open peer-review network" },
  { term: "Cost", details: "Free to read and to publish" },
  { term: "Licence", details: "CC BY 4.0 by default" },
  { term: "Identifiers", details: <code>sch:xxxx-xxxx-xxxx/vN</code> },
  { term: "Sign-in", details: "Passkey and ORCID iD" },
  { term: "Review", details: "Six-criterion rubric; anonymous but accountable" },
  { term: "AI", details: "Advisory pre-review, never a verdict" },
  {
    term: "Verification",
    details: (
      <>
        In the browser, or offline with <code>scholium verify</code>
      </>
    ),
  },
  { term: "Moderation", details: "Public policy, signed decisions, 48-hour target" },
  { term: "Recovery", details: "Three of five guardians" },
  { term: "Token", details: "None" },
];

export function FaqSection() {
  const head = useReveal<HTMLElement>();
  const glance = useReveal<HTMLElement>();

  return (
    <section className="section section-alt" id="faq" aria-labelledby="faq-title">
      <div className="wrap">
        <header className="sec-head reveal" ref={head}>
          <p className="eyebrow">Questions</p>
          <h2 id="faq-title" className="title">
            Questions, answered.
          </h2>
        </header>
        <div className="faq-grid">
          <aside className="glance reveal" aria-labelledby="glance-title" ref={glance}>
            <h3 id="glance-title">Scholium at a glance</h3>
            <dl>
              {GLANCE_FACTS.map((fact) => (
                <div key={fact.term}>
                  <dt>{fact.term}</dt>
                  <dd>{fact.details}</dd>
                </div>
              ))}
            </dl>
          </aside>

          <div className="faq">
            {FAQ_ENTRIES.map(({ question, answer }) => (
              <details key={question}>
                <summary>
                  <h3>{question}</h3>
                  <span className="pm" aria-hidden="true">
                    <Icon name="plus" />
                  </span>
                </summary>
                <div className="ans">
                  <p>{answer}</p>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default FaqSection;
