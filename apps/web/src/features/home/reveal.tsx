"use client";

import { createElement, useEffect, useRef, type ReactNode } from "react";

let sharedObserver: IntersectionObserver | null = null;

function getSharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (sharedObserver) return sharedObserver;
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          sharedObserver?.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );
  return sharedObserver;
}

export function getRevealObserver(): IntersectionObserver | null {
  return getSharedObserver();
}

export function observeReveal(element: Element | null): void {
  if (!element) return;
  getSharedObserver()?.observe(element);
}

export function useReveal<T extends HTMLElement = HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (node) observeReveal(node);
    return () => {
      if (node) getSharedObserver()?.unobserve(node);
    };
  }, []);
  return ref;
}

export interface RevealProps {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "span" | "figure" | "p";
  delay?: number;
}

export function Reveal({ children, className, as = "div", delay }: RevealProps) {
  const ref = useReveal<HTMLElement>();
  const style = delay ? { ["--d" as string]: delay } : undefined;
  return createElement(as, { ref, className: className ? `reveal ${className}` : "reveal", style }, children);
}

export default { getRevealObserver, observeReveal, useReveal, Reveal };
