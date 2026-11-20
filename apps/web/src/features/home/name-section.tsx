"use client";

import { BrandMark } from "../ui-kit/brand-mark";
import { useReveal } from "./reveal";
import "./home.css";
import "./closing.css";

/**
 * #name — the brand glyph beside a dictionary entry
 * (docs/homepage/index.html). The glyph is the shared BrandMark with its
 * `animated` prop: the part class names it adds are assembled on reveal by
 * brand.css (the page pops in, the lines grow in from the left with a
 * stagger, the strip grows downward, the bracket slides in on a spring).
 * The entry is set the way a dictionary sets one: dfn, pronunciation, the
 * definition against a margin-note rule, then the lead.
 */

export function NameSection() {
  const glyph = useReveal<HTMLDivElement>();
  const entry = useReveal<HTMLDivElement>();

  return (
    <section className="section" id="name" aria-labelledby="name-title">
      <div className="wrap name-grid">
        <div className="name-glyph reveal" aria-hidden="true" ref={glyph}>
          {/* height auto lets closing.css size the svg from its width; the
              mark's own default height is a nav-sized 48px. */}
          <BrandMark variant="glyph" decorative animated style={{ height: "auto" }} />
        </div>
        <div className="reveal" style={{ ["--d" as string]: 1 }} ref={entry}>
          <p className="eyebrow">The name</p>
          <h2 id="name-title" className="dict-word">
            <dfn id="def-scholium">scholium</dfn>
          </h2>
          <p className="pron">
            /ˈskoʊ·li·əm/ · noun · plural <i>scholia</i>
          </p>
          <p className="def">An explanatory note written in the margin of a scholarly text.</p>
          <p className="lead">
            For more than two thousand years, readers have argued with texts in their margins. Scholium keeps that
            conversation next to the paragraph it is about, and signs it.
          </p>
        </div>
      </div>
    </section>
  );
}

export default NameSection;
