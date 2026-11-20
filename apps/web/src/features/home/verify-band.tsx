import { Icon, type IconName } from "./icons";
import { Reveal } from "./reveal";
import "./home.css";
import "./journey.css";

const COMMAND = "scholium verify reward-calibration.car";

const TERMINAL_LABEL =
  "Example terminal session: scholium verify reward-calibration.car reports signed by all authors, history intact, files match, timestamp anchor pending, no retraction, verified.";

interface Check {
  mark: string;
  tone: "ok" | "pend";
  text: string;
  dim?: string;
}

const CHECKS: Check[] = [
  { mark: "✓", tone: "ok", text: "Signed by all authors", dim: "(2 of 2)" },
  { mark: "✓", tone: "ok", text: "History intact", dim: "(v1 → v2 → v3)" },
  { mark: "✓", tone: "ok", text: "Files match what the authors signed" },
  { mark: "◷", tone: "pend", text: "Timestamp anchor pending" },
  { mark: "✓", tone: "ok", text: "No retraction" },
];

interface VerifyLink {
  href: string;
  icon: IconName;
  title: string;
  text: string;
}

const LINKS: VerifyLink[] = [
  {
    href: "/verify",
    icon: "doc",
    title: "Check a file in your browser",
    text: "Drop a PDF to see whether it matches what the authors signed.",
  },
  {
    href: "/papers",
    icon: "download",
    title: "Export what you cite",
    text: "BibTeX, RIS, or the full paper archive.",
  },
  {
    href: "/network",
    icon: "nodes",
    title: "See the network",
    text: "The node's standing, log head and moderation statistics.",
  },
];

/**
 * The Verify band (#verify). `data-theme="dark"` on the section scopes the dark
 * tokens to it, so it stays dark in the light and the dark theme alike.
 */
export function VerifyBand() {
  return (
    <section className="section band-dark" id="verify" data-theme="dark" aria-labelledby="verify-title">
      <div className="wrap">
        <Reveal className="sec-head">
          <p className="eyebrow">Verify anywhere</p>
          <h2 id="verify-title" className="title">Take the record with you.</h2>
          <p className="lead">
            Export any paper, with every version, signature and review, as a single archive.{" "}
            <b>It verifies offline, on your own machine, with no help from Scholium.</b>
          </p>
        </Reveal>

        <Reveal className="term-wrap">
          <div className="term" role="img" aria-label={TERMINAL_LABEL}>
            <div className="term-bar"><span>~/papers</span><span>offline</span></div>
            <pre>
              <code>
                <span className="t-line">
                  <span className="t-prompt">{"$ "}</span>
                  <span className="typed">{COMMAND}</span>
                  <span className="caret" />
                </span>
                {CHECKS.map((check, k) => (
                  <span className="t-line t-out" style={{ ["--k" as string]: k }} key={check.text}>
                    <span className={check.tone === "ok" ? "t-ok" : "t-pend"}>{check.mark}</span>
                    {" "}
                    {check.text}
                    {check.dim ? <>{" "}<span className="t-dim">{check.dim}</span></> : null}
                  </span>
                ))}
                <span className="t-line t-out t-final" style={{ ["--k" as string]: CHECKS.length }}>Verified.</span>
              </code>
            </pre>
          </div>
        </Reveal>

        <div className="vlinks">
          {LINKS.map((link, i) => (
            <Reveal className="vlink-cell" delay={i} key={link.href}>
              <a className="vlink" href={link.href}>
                <Icon name={link.icon} />
                <b>{link.title}</b>
                <span>{link.text}</span>
              </a>
            </Reveal>
          ))}
        </div>

        <Reveal as="p" className="roadmap">
          <span className="tag">Planned</span>{" "}
          Public timestamp anchoring, DOIs and independent library nodes.
        </Reveal>
      </div>
    </section>
  );
}

export default VerifyBand;
