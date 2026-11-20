"use client";

import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "./icons";
import { Reveal, useReveal } from "./reveal";
import { TamperDemo } from "./tamper-demo";
import "./home.css";
import "./provenance.css";

/** A trio item that rises into view, staggered by its index. */
function TrioItem({
  icon,
  delay,
  title,
  children,
}: {
  icon: IconName;
  delay: number;
  title: string;
  children: ReactNode;
}) {
  const ref = useReveal<HTMLLIElement>();
  return (
    <li ref={ref} className="reveal" style={{ "--d": delay } as CSSProperties}>
      <Icon name={icon} />
      <b>{title}</b>
      {children}
    </li>
  );
}

const STATUS_CHIPS: { className: string; icon: IconName; word: string }[] = [
  { className: "chip-preprint", icon: "circle", word: "Preprint" },
  { className: "chip-review", icon: "eye", word: "Under review" },
  { className: "chip-reviewed", icon: "check-circle", word: "Reviewed" },
  { className: "chip-corrected", icon: "pencil", word: "Corrected" },
  { className: "chip-retracted", icon: "ban", word: "Retracted" },
];

/**
 * The homepage Provenance section (#signed): the eyebrow, title and lead, the
 * tamper demo, the three promises, and the status chips that show corrections
 * are part of the record.
 */
export function ProvenanceSection() {
  const headerRef = useReveal<HTMLElement>();
  const chipsRef = useReveal<HTMLUListElement>();

  return (
    <section className="section section-alt" id="signed" aria-labelledby="signed-title">
      <div className="wrap">
        <header ref={headerRef} className="sec-head reveal">
          <p className="eyebrow">Provenance</p>
          <h2 id="signed-title" className="title">
            Signed by you.{" "}
            <br />
            Checkable by anyone.
          </h2>
          <p className="lead">
            When you submit, your browser fingerprints every file and signs the
            version with a key that lives on your device.{" "}
            <b>Each new version records the fingerprint of the one before</b>, so
            changing a single byte anywhere breaks the chain where everyone can
            see it.
          </p>
        </header>

        <TamperDemo />

        <ul className="trio">
          <TrioItem icon="key" delay={0} title="Your key stays yours.">
            Your passkey unlocks a signing key that lives on your device.
            Scholium never sees it.
          </TrioItem>
          <TrioItem icon="users" delay={1} title="Every author agrees.">
            Each co-author signs consent before a version is listed. Nobody is
            added to a paper without saying yes.
          </TrioItem>
          <TrioItem icon="hash" delay={2} title="A stable ID to cite.">
            Each paper and version has its own address, like{" "}
            <code>sch:k3f9-q2xz-7mwd/v1</code>, and v1 still resolves after v3.
          </TrioItem>
        </ul>

        <div className="chips-row">
          <Reveal>
            <h3>Corrections are part of the record.</h3>
            <p>
              Papers change, and the record shows how. Corrections and
              retractions are signed records with a banner on every version.
              Nothing is quietly edited.
            </p>
          </Reveal>
          <ul
            ref={chipsRef}
            className="chips reveal"
            role="list"
            aria-label="Paper statuses"
          >
            {STATUS_CHIPS.map((chip, index) => (
              <li
                key={chip.word}
                className={`chip ${chip.className}`}
                style={{ "--k": index } as CSSProperties}
              >
                <Icon name={chip.icon} />
                {chip.word}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export default ProvenanceSection;
