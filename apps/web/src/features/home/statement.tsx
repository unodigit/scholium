"use client";

import { useEffect, useRef } from "react";

import "./home.css";

const STATEMENT =
  "Today, the scientific record lives in someone's database. If that operator changes its policy, runs out of money or makes a mistake, the record changes with it. Scholium signs every paper, version and review where it is written, so anyone can check the record, and any faithful copy can prove it is the original.";

export function Statement() {
  const ref = useRef<HTMLElement>(null);
  const paraRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const para = paraRef.current;
    if (!para) return;
    // split into words
    const words = STATEMENT.split(/(\s+)/);
    para.textContent = "";
    const spans: HTMLSpanElement[] = [];
    for (const part of words) {
      if (/^\s+$/.test(part)) {
        para.append(document.createTextNode(part));
        continue;
      }
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = part;
      para.append(span);
      spans.push(span);
    }

    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      spans.forEach((s) => s.classList.add("on"));
      return;
    }

    const onScroll = () => {
      const r = para.getBoundingClientRect();
      const vh = window.innerHeight;
      // progress as paragraph scrolls through viewport
      const start = vh * 0.9;
      const end = vh * 0.25;
      const progress = Math.min(1, Math.max(0, (start - r.top) / (start - end)));
      const count = Math.floor(progress * spans.length);
      spans.forEach((s, i) => {
        if (i < count) s.classList.add("on");
        else s.classList.remove("on");
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section className="section" aria-labelledby="why-title">
      <div className="wrap narrow">
        <h2 id="why-title" className="eyebrow">Why Scholium</h2>
        {/* The words are in the server-rendered HTML, plain and fully inked, so
            the paragraph reads with scripts off and to crawlers. Once mounted,
            the effect above swaps the text for one span per word, which ink in
            as the paragraph scrolls through the viewport. */}
        <p className="statement-text" ref={paraRef} data-words="">{STATEMENT}</p>
      </div>
    </section>
  );
}

export default Statement;
