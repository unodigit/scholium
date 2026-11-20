"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Icon, type IconName } from "./icons";
import { Reveal } from "./reveal";
import { Spring } from "./spring";
import "./home.css";
import "./journey.css";

interface Role {
  id: string;
  label: string;
  title: string;
  lead: string;
  cta: { href: string; label: string };
  points: { icon: IconName; text: ReactNode }[];
}

const ROLES: Role[] = [
  {
    id: "authors",
    label: "Authors",
    title: "Publish in minutes. Prove priority for good.",
    lead: "Your signature and timestamp travel with the paper, so the question of who said it first has an answer anyone can check.",
    cta: { href: "/submit", label: "Submit a paper" },
    points: [
      { icon: "upload", text: "Upload a PDF or LaTeX source, with code and data alongside." },
      { icon: "hash", text: <>Cite a stable ID from day one: <code>sch:k3f9-q2xz-7mwd</code>.</> },
      { icon: "clock", text: "Get feedback before your deadline: AI pre-review, formal reviews and discussion." },
      { icon: "reply", text: "Already on arXiv? Import the paper and claim it with your signature." },
    ],
  },
  {
    id: "reviewers",
    label: "Reviewers",
    title: "Review anonymously. Stay accountable.",
    lead: "Your name can stay hidden from the authors while your review stays signed, structured and yours.",
    cta: { href: "/papers", label: "Find a paper to review" },
    points: [
      { icon: "clipboard", text: "A clear rubric: soundness, evidence, reproducibility, novelty, clarity and limitations." },
      { icon: "eye-off", text: "Reports stay sealed until two are in, or 21 days pass." },
      { icon: "shield", text: "Conflicts of interest are checked before you start." },
      { icon: "pencil", text: "Update your review when the authors post a new version." },
    ],
  },
  {
    id: "readers",
    label: "Readers",
    title: "Know what's been checked.",
    lead: "Status, reviews and proof sit on the paper page, so you can tell a fresh upload from a well-reviewed result at a glance.",
    cta: { href: "/papers", label: "Browse papers" },
    points: [
      { icon: "check-circle", text: "A plain status on every paper: Preprint, Under review, Reviewed, Corrected or Retracted." },
      { icon: "shield", text: "A Proof tab that checks signatures, history and files in your browser." },
      { icon: "search", text: "Search with filters for reviewed papers and papers with code." },
      { icon: "book", text: "Notes anchored to the paragraph they're about. Export to BibTeX or RIS." },
    ],
  },
  {
    id: "libraries",
    label: "Libraries",
    title: "Keep your researchers' work, and prove it.",
    lead: "Every record is signed and content-addressed, so a copy you hold can be checked against the original without asking us.",
    cta: { href: "/network", label: "See the network" },
    points: [
      { icon: "download", text: "Export complete paper archives that verify offline." },
      { icon: "scale", text: "Moderation decisions are public, signed and tied to a written policy clause." },
      { icon: "nodes", text: "A network page shows the node's standing and log head." },
      { icon: "library", text: "Planned: independent library nodes and public timestamp anchoring." },
    ],
  },
];

/* ---- Client-only switch ------------------------------------------------------
   The server render, and the first client render while hydrating, show all four
   panels. Once the client has taken over this reads true and the inactive three
   get `hidden`. */
const subscribeNever = () => () => {};
const clientTrue = () => true;
const serverFalse = () => false;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ---- The sliding indicator -----------------------------------------------------
   Position and width are springs (response 0.4 s, damping 0.8) on the Spring
   class. Both are applied as a transform: translateX for the position and scaleX
   for the width, measured against the width the indicator last settled at. A new
   target retargets the springs in flight, so the indicator keeps its velocity if
   the user changes their mind half way. */
const SETTLE_PX = 0.05;
const SETTLE_SCALE = 0.0005;

function useSegmentIndicator(
  active: number,
  tabs: RefObject<(HTMLButtonElement | null)[]>,
  indicator: RefObject<HTMLSpanElement | null>,
  track: RefObject<HTMLDivElement | null>,
) {
  const place = useRef<(index: number, animate: boolean) => void>(() => {});
  const placed = useRef(active);

  useLayoutEffect(() => {
    const el = indicator.current;
    if (!el) return;

    const x = new Spring(0.4, 0.8);
    const scale = new Spring(0.4, 0.8);
    let base = 0;
    let raf = 0;
    let last = 0;
    let alive = true;

    const paint = () => {
      el.style.transform = `translateX(${x.value}px) scaleX(${scale.value})`;
    };

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      x.step(dt);
      scale.step(dt);
      if (x.isSettled(SETTLE_PX) && scale.isSettled(SETTLE_SCALE)) {
        x.value = x.target;
        scale.value = scale.target;
        paint();
        raf = 0;
        return;
      }
      paint();
      raf = requestAnimationFrame(frame);
    };

    place.current = (index, animate) => {
      const tab = tabs.current[index];
      if (!tab) return;
      const left = tab.offsetLeft;
      const width = tab.offsetWidth;
      // Not laid out (yet): keep the indicator where the stylesheet put it.
      if (width <= 0) return;

      if (!animate || typeof requestAnimationFrame !== "function") {
        // Jump: cancel any flight and re-base the indicator on this tab's width.
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        base = width;
        el.style.width = `${width}px`;
        x.value = x.target = left;
        x.velocity = 0;
        scale.value = scale.target = 1;
        scale.velocity = 0;
        paint();
        return;
      }

      x.target = left;
      scale.target = base > 0 ? width / base : 1;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    // Measure on mount, and again whenever the track changes size or the fonts land.
    const settle = () => place.current(placed.current, false);
    settle();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(settle) : null;
    const trackEl = track.current;
    if (observer && trackEl) observer.observe(trackEl);
    else window.addEventListener("resize", settle);
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => { if (alive) settle(); });
    }

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", settle);
      place.current = () => {};
    };
  }, [tabs, indicator, track]);

  useLayoutEffect(() => {
    if (placed.current === active) return;
    placed.current = active;
    place.current(active, !prefersReducedMotion());
  }, [active]);
}

export function RolesSection() {
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const clientReady = useSyncExternalStore(subscribeNever, clientTrue, serverFalse);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const trackRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  useSegmentIndicator(active, tabRefs, indicatorRef, trackRef);

  const select = (index: number, focus: boolean) => {
    if (index !== active) {
      setActive(index);
      setMoved(true);
    }
    if (focus) tabRefs.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = ROLES.length - 1;
    let next: number | undefined;
    switch (event.key) {
      case "ArrowRight": next = index === last ? 0 : index + 1; break;
      case "ArrowLeft": next = index === 0 ? last : index - 1; break;
      case "Home": next = 0; break;
      case "End": next = last; break;
      default: return;
    }
    event.preventDefault();
    select(next, true);
  };

  return (
    <section className="section roles" id="who" aria-labelledby="who-title">
      <div className="wrap">
        <Reveal className="sec-head">
          <p className="eyebrow">Who it&apos;s for</p>
          <h2 id="who-title" className="title">Built for everyone who touches a paper.</h2>
        </Reveal>

        <Reveal className="seg-wrap">
          <div className="seg" role="tablist" aria-label="Choose your role" ref={trackRef}>
            <span className="seg-ind" aria-hidden="true" ref={indicatorRef} />
            {ROLES.map((role, i) => (
              <button
                key={role.id}
                ref={(node) => { tabRefs.current[i] = node; }}
                role="tab"
                type="button"
                id={`tab-${role.id}`}
                aria-controls={`panel-${role.id}`}
                aria-selected={i === active}
                tabIndex={i === active ? 0 : -1}
                onClick={() => select(i, false)}
                onKeyDown={(event) => onKeyDown(event, i)}
              >
                {role.label}
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal className="panels">
          {ROLES.map((role, i) => (
            <div
              key={role.id}
              className={moved && i === active ? "panel entering" : "panel"}
              role="tabpanel"
              id={`panel-${role.id}`}
              aria-labelledby={`tab-${role.id}`}
              tabIndex={0}
              hidden={clientReady && i !== active}
              data-active={i === active}
            >
              <div>
                <h3>{role.title}</h3>
                <p className="p-lead">{role.lead}</p>
                <a className="btn btn-filled" href={role.cta.href}>
                  {role.cta.label} <Icon name="arrow" className="ico-arrow" />
                </a>
              </div>
              <ul>
                {role.points.map((point, k) => (
                  <li key={k}>
                    <Icon name={point.icon} />
                    <span>{point.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

export default RolesSection;
