"use client";

import { Icon } from "./icons";
import { SealedReports } from "./sealed-reports";
import "./home.css";
import "./review.css";

const RUBRIC_ROWS: Array<{ name: string; score: number }> = [
  { name: "Soundness", score: 4 },
  { name: "Evidence", score: 4 },
  { name: "Reproducibility", score: 3 },
  { name: "Novelty", score: 3 },
  { name: "Clarity", score: 5 },
  { name: "Limitations", score: 4 },
];

export function OpenReviewSection() {
  return (
    <section className="section" id="review" aria-labelledby="review-title">
      <div className="wrap">
        <header className="sec-head reveal">
          <p className="eyebrow">Open review</p>
          <h2 id="review-title" className="title">Peer review, out in the open.</h2>
          <p className="lead">
            Formal reviews sit in the margin beside the paper, scored against a public rubric. <b>Anyone can read them.</b> Reviewers can stay anonymous to the authors and still be held to account.
          </p>
        </header>

        <div className="bento">
          <article className="tile wide reveal">
            <div>
              <span className="t-ico">
                <Icon name="clipboard" />
              </span>
              <h3>Structured, not starred.</h3>
              <p>Six criteria, a confidence level and a recommendation. A formal review that is only free text is sent back to its author.</p>
            </div>
            <div
              className="rubric reveal"
              role="img"
              aria-label="Example review scores: soundness 4 of 5, evidence 4 of 5, reproducibility 3 of 5, novelty 3 of 5, clarity 5 of 5, limitations 4 of 5. Confidence high."
            >
              {RUBRIC_ROWS.map((row, r) => (
                <div className="rrow" key={row.name}>
                  <span>{row.name}</span>
                  <span className="dots">
                    {Array.from({ length: 5 }).map((_, k) => {
                      const filled = k < row.score;
                      return filled ? (
                        <i className="f" key={k} style={{ ["--r" as string]: r, ["--k" as string]: k }} />
                      ) : (
                        <i key={k} />
                      );
                    })}
                  </span>
                  <span className="rv">{row.score}/5</span>
                </div>
              ))}
              <div className="rfoot">
                <span>
                  Confidence <b>High</b>
                </span>
                <span>·</span>
                <span>
                  Recommendation <b>Minor revisions</b>
                </span>
              </div>
            </div>
          </article>

          <article className="tile tile-sealed reveal" style={{ ["--d" as string]: 1 }}>
            <span className="t-ico">
              <Icon name="eye-off" />
            </span>
            <h3>Sealed until it&apos;s fair.</h3>
            <p>Reports stay sealed until two reviewers have committed theirs, or 21 days pass. Nobody writes in the shadow of the first review.</p>
            <SealedReports />
          </article>

          <article className="tile reveal">
            <span className="t-ico">
              <Icon name="shield" />
            </span>
            <h3>Anonymous, still accountable.</h3>
            <p>One formal review per person per paper. Co-authors and conflicts of interest are refused, even when the reviewer&apos;s name is hidden.</p>
          </article>
          <article className="tile reveal" style={{ ["--d" as string]: 1 }}>
            <span className="t-ico">
              <Icon name="reply" />
            </span>
            <h3>Authors answer back.</h3>
            <p>Point-by-point responses link to each review item, and reviewers can update their review against a new version.</p>
          </article>
          <article className="tile reveal" style={{ ["--d" as string]: 2 }}>
            <span className="t-ico">
              <Icon name="message" />
            </span>
            <h3>Discussion with manners.</h3>
            <p>Verified members can discuss any paper and annotate any paragraph. Helpful votes order the thread; they never change a paper&apos;s status.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

export { OpenReviewSection as OpenReview };
export default OpenReviewSection;