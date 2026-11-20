"use client";

import { useReveal } from "./reveal";
import { Icon } from "./icons";
import "./home.css";
import "./closing.css";

/**
 * #principles — "Four things Scholium won't do." (docs/homepage/index.html):
 * the four cards No token., No paywall., No verdicts. and No quiet edits.,
 * each an X icon beside the heading and the reference's text. The odd cards
 * reveal one step after the even ones (--d: 1), as the reference staggers
 * them.
 */

interface Principle {
  readonly title: string;
  readonly body: string;
}

const PRINCIPLES: readonly Principle[] = [
  {
    title: "No token.",
    body: "There is nothing to trade or speculate on, and no token-weighted votes on scientific questions. Ever.",
  },
  {
    title: "No paywall.",
    body: "Free to read and free to publish, with an open licence by default.",
  },
  {
    title: "No verdicts.",
    body: "Scholium isn't a journal. It lists, reviews and badges papers. It doesn't accept or reject science.",
  },
  {
    title: "No quiet edits.",
    body: "Corrections, retractions and moderation decisions are signed, public records. Old versions stay readable.",
  },
];

export function PrinciplesSection() {
  const head = useReveal<HTMLElement>();
  const cards = [
    useReveal<HTMLElement>(),
    useReveal<HTMLElement>(),
    useReveal<HTMLElement>(),
    useReveal<HTMLElement>(),
  ];

  return (
    <section className="section section-alt" id="principles" aria-labelledby="principles-title">
      <div className="wrap">
        <header className="sec-head reveal" ref={head}>
          <p className="eyebrow">Principles</p>
          <h2 id="principles-title" className="title">
            Four things Scholium won&apos;t do.
          </h2>
        </header>
        <div className="principles">
          {PRINCIPLES.map((principle, index) => (
            <article
              key={principle.title}
              className="principle reveal"
              ref={cards[index]}
              style={index % 2 === 1 ? { ["--d" as string]: 1 } : undefined}
            >
              <h3>
                <Icon name="x" />
                {principle.title}
              </h3>
              <p>{principle.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default PrinciplesSection;
