"use client";

import { useEffect, useRef } from "react";

export function SealedReports() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      window.setTimeout(() => {
        el.classList.add("open");
      }, reduceMotion ? 0 : 1400);
    };

    const checkVisible = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      return rect.top < vh && rect.bottom > 0;
    };

    if (checkVisible()) open();

    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) open();
        },
        { threshold: 0.6 },
      );
      io.observe(el);
      return () => io.disconnect();
    }

    if (!opened) open();
    return;
  }, []);

  return (
    <div className="sealed" id="sealed" aria-hidden="true" ref={ref}>
      <div className="rep">
        <div className="rep-top">
          <svg className="lock" viewBox="0 0 24 24">
            <path className="shackle" d="M8 11V8a4 4 0 0 1 8 0v3" />
            <rect x="5" y="11" width="14" height="9.5" rx="2.2" />
          </svg>
          <span className="rep-state">
            <em className="s1">Committed</em>
            <em className="s2">Revealed</em>
          </span>
        </div>
        <p className="rep-name">Reviewer A</p>
        <span className="rep-lines">
          <b></b>
          <b></b>
          <b></b>
        </span>
      </div>
      <div className="rep">
        <div className="rep-top">
          <svg className="lock" viewBox="0 0 24 24">
            <path className="shackle" d="M8 11V8a4 4 0 0 1 8 0v3" />
            <rect x="5" y="11" width="14" height="9.5" rx="2.2" />
          </svg>
          <span className="rep-state">
            <em className="s1">Committed</em>
            <em className="s2">Revealed</em>
          </span>
        </div>
        <p className="rep-name">Reviewer B</p>
        <span className="rep-lines">
          <b></b>
          <b></b>
          <b></b>
        </span>
      </div>
    </div>
  );
}

export { SealedReports as SealedReport };
export { SealedReports as Sealed };
export default SealedReports;