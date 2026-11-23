"use client";

import { useEffect, useState } from "react";

import { BrandLogo } from "../ui-kit/brand-logo";
import { useSignedIn } from "../../components/nav/session";
import "./home.css";

export interface HomeNavProps { signedIn?: boolean; }

export function HomeNav({ signedIn: signedInProp }: HomeNavProps = {}) {
  const isSignedIn = useSignedIn(signedInProp);
  const [scrolled, setScrolled] = useState(false);
  const signedIn = isSignedIn;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`nav${scrolled ? " scrolled" : ""}`} id="nav">
      <div className="wrap nav-inner">
        <a className="nav-logo" href="#top" aria-label="Scholium, back to top">
          <BrandLogo size="md" />
        </a>
        <nav aria-label="Sections">
          <ul className="nav-links">
            <li><a href="#signed">Provenance</a></li>
            <li><a href="#review">Open review</a></li>
            <li><a href="#ai">AI pre-review</a></li>
            <li><a href="#verify">Verify</a></li>
            <li><a href="#faq">FAQ</a></li>
            <li><a href="/docs">Docs</a></li>
          </ul>
        </nav>
        <div className="nav-cta">
          {signedIn ? (
            <>
              <a className="nav-signin" href="/papers">Browse papers</a>
              <a className="btn btn-filled btn-sm" href="/me">Your dashboard</a>
            </>
          ) : (
            <>
              <a className="nav-signin" href="/signin">Sign in</a>
              <a className="btn btn-filled btn-sm" href="/submit">Submit a paper</a>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export default HomeNav;
