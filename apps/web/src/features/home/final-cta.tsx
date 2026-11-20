import { BrandLogo } from "../ui-kit/brand-logo";
import { Icon } from "./icons";
import "./home.css";

export function FinalCta() {
  return (
    <section className="final" aria-labelledby="final-title">
      <div className="wrap reveal">
        <BrandLogo
          size="lg"
          style={{ ["--brand-mark-height" as string]: "44px", marginBottom: "40px" }}
        />
        <h2 id="final-title" className="title">Your next paper deserves a margin.</h2>
        <p className="lead">Free to read. Free to publish. Signed by you, from the first version.</p>
        <div className="cta-row">
          <a className="btn btn-filled btn-lg" href="/submit">Submit a paper</a>
          <a className="btn btn-tinted btn-lg" href="/papers">Browse papers <Icon name="arrow" className="ico-arrow" /></a>
        </div>
      </div>
    </section>
  );
}

export default FinalCta;
