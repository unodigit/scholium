"use client";

import { useEffect } from "react";

import { getRevealObserver, observeReveal } from "./reveal";

/**
 * What the reference's script marks as it comes into view
 * (docs/homepage/index.html): scroll reveals, and the blocks whose own
 * entrance (the chain, the rubric, the AI panel, the terminal, the steps, the
 * chips, the big glyph) plays when `.in` arrives.
 */
export const REVEAL_SELECTOR = ".reveal, .demo, .rubric, .ai-panel, .term, .steps, .chips, .glyph-big";

/**
 * Registers every block the homepage reveals with the one shared
 * `IntersectionObserver` in `reveal.tsx`, once the page has mounted.
 *
 * Under `html[data-home-js]` these blocks start hidden and only gain `.in`
 * from that observer. A section that registers its own blocks (`Reveal`,
 * `useReveal`) is unaffected: observing an element twice is a no-op. A section
 * that only writes the class names gets observed here, so no block of the page
 * can be left hidden because its section forgot to ask. Blocks already shown
 * are left alone.
 *
 * Renders nothing.
 */
export function RevealScan() {
  useEffect(() => {
    const pending = [...document.querySelectorAll(REVEAL_SELECTOR)].filter(
      (element) => !element.classList.contains("in"),
    );
    for (const element of pending) observeReveal(element);
    return () => {
      for (const element of pending) getRevealObserver()?.unobserve(element);
    };
  }, []);

  return null;
}

export default RevealScan;
