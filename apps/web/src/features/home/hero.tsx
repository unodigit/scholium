"use client";

import { Icon } from "./icons";
import { HeroStage } from "./hero-stage";
import "./home.css";

export function Hero() {
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <div className="hero-ruling" aria-hidden="true"></div>
      <div className="wrap hero-copy">
        <p className="hero-eyebrow h-in" style={{ ["--t" as string]: 0 }}>
          <span className="dot"><Icon name="check" /></span>
          Signed, open preprints and peer review
        </p>
        <h1 id="hero-title" className="display">
          <span className="line"><span style={{ ["--i" as string]: 0 }}>The preprint, <em>signed.</em></span></span>
          <span className="line"><span style={{ ["--i" as string]: 1 }}>The review, <em>open.</em></span></span>
          <span className="line"><span style={{ ["--i" as string]: 2 }}>The record, <em>kept.</em></span></span>
        </h1>
        <p className="lead h-in" style={{ ["--t" as string]: 420 }}>
          Scholium is a free preprint and peer-review network. <b>Every paper, version and review carries its author&apos;s signature</b>, so anyone can check who wrote what, and when, without taking anyone&apos;s word for it.
        </p>
        <div className="cta-row h-in" style={{ ["--t" as string]: 540 }}>
          <a className="btn btn-filled btn-lg" href="/submit">Submit a paper</a>
          <a className="btn btn-tinted btn-lg" href="/papers">Browse papers <Icon name="arrow" className="ico-arrow" /></a>
        </div>
        <p className="fineprint h-in" style={{ ["--t" as string]: 640 }}>
          <Icon name="key" />Sign in with a passkey and your ORCID iD. Your key never leaves your device.
        </p>
      </div>

      <HeroStage />
    </section>
  );
}

export default Hero;
