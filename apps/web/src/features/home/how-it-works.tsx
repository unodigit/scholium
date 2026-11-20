import { Reveal } from "./reveal";
import "./home.css";
import "./journey.css";

const STEPS = [
  {
    title: "Sign in",
    text: "Create a passkey and link your ORCID iD. It takes about a minute, and there is no password.",
  },
  {
    title: "Submit",
    text: "Upload your PDF or LaTeX. Your browser fingerprints and signs it, and your co-authors add their consent.",
  },
  {
    title: "Get listed",
    text: "A volunteer moderator checks it against public policy, aiming to decide within 48 hours. Every decision is a signed record.",
  },
  {
    title: "Gather the margin",
    text: "AI pre-review, formal reviews and discussion collect beside the text, version by version.",
  },
];

/**
 * How it works (#how). The connector lines are drawn by CSS when the list is
 * revealed: horizontally on desktop, vertically under 900px.
 */
export function HowItWorksSection() {
  return (
    <section className="section section-alt how" id="how" aria-labelledby="how-title">
      <div className="wrap">
        <Reveal className="sec-head">
          <p className="eyebrow">How it works</p>
          <h2 id="how-title" className="title">From draft to discussed, in four steps.</h2>
        </Reveal>
        <Reveal className="steps-reveal">
          {/* role="list": list-style: none would otherwise drop the list semantics in Safari. */}
          <ol className="steps" role="list">
            {STEPS.map((step, k) => (
              <li className="step" style={{ ["--k" as string]: k }} key={step.title}>
                <span className="step-n" aria-hidden="true">{k + 1}</span>
                <span className="step-line" aria-hidden="true" />
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}

export default HowItWorksSection;
