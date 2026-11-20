"use client";

import { useEffect, useRef } from "react";

import { Spring } from "./spring";
import { Icon } from "./icons";
import "./home.css";

export function HeroStage() {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: fine) and (min-width: 900px)");
    if (!mq.matches) return;

    const springX = new Spring(0.45, 0.8);
    const springY = new Spring(0.45, 0.8);
    let targetX = 0;
    let targetY = 0;
    let raf = 0;

    const update = () => {
      springX.step(1 / 60);
      springY.step(1 / 60);
      const rx = springY.value;
      const ry = springX.value;
      stage.style.transform = `perspective(1200px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      raf = requestAnimationFrame(update);
    };

    const onMove = (e: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const nx = (e.clientX - cx) / (rect.width / 2);
      const ny = (e.clientY - cy) / (rect.height / 2);
      targetY = Math.max(-4, Math.min(4, nx * 4));
      targetX = Math.max(-3, Math.min(3, -ny * 3));
      springX.retarget(targetY);
      springY.retarget(targetX);
    };
    const onLeave = () => {
      springX.retarget(0);
      springY.retarget(0);
    };

    const host = stage.parentElement ?? stage;
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <figure className="stage-wrap">
      <div className="stage" id="stage" ref={stageRef} aria-hidden="true">
        <article className="paper">
          <div className="paper-top">
            <span className="chip chip-reviewed"><Icon name="check-circle" />Reviewed</span>
            <span className="paper-v">v3 · 3 versions</span>
            <span className="idpill">sch:k3f9-q2xz-7mwd/v3</span>
          </div>
          <h2 className="paper-title">Reward Model Calibration Under Distribution Shift</h2>
          <p className="paper-meta">Lena Haddad, Rafael Silva · cs.LG · CC BY 4.0</p>
          <p className="paper-label">Abstract</p>
          <p className="paper-abs">
            We measure how well a learned reward model tracks human preference when prompts drift away from its training distribution.{" "}
            <mark className="hl">On the shifted split, calibration error rises by 11 percent</mark>, and a single temperature parameter recovers most of the loss.
          </p>
          <div className="paper-body">
            <div>
              <p className="paper-h">1&nbsp;&nbsp;Introduction</p>
              <div className="ptext">
                <i style={{ ["--w" as string]: "100%", ["--k" as string]: 0 }}></i>
                <i style={{ ["--w" as string]: "96%", ["--k" as string]: 1 }}></i>
                <i style={{ ["--w" as string]: "99%", ["--k" as string]: 2 }}></i>
                <i style={{ ["--w" as string]: "93%", ["--k" as string]: 3 }}></i>
                <i style={{ ["--w" as string]: "98%", ["--k" as string]: 4 }}></i>
                <i style={{ ["--w" as string]: "58%", ["--k" as string]: 5 }}></i>
              </div>
            </div>
            <figure className="fig">
              <svg viewBox="0 0 236 128">
                <rect x=".5" y=".5" width="235" height="127" rx="11" fill="var(--bg)" stroke="var(--rule)" />
                <path d="M28 104H214M28 104V18" stroke="var(--ink-3)" strokeWidth="1" fill="none" />
                <path d="M28 104L214 18" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="3 4" fill="none" />
                <path className="curve" pathLength={1} d="M28 104C78 86 132 56 214 22" stroke="var(--accent)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
                <path className="curve" pathLength={1} d="M28 104C82 101 140 82 214 52" stroke="var(--pending)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
              </svg>
              <figcaption>Figure 1. Calibration before and after the shift.</figcaption>
            </figure>
          </div>
          <div className="paper-foot">
            <span className="verify">
              <span className="verify-checking"><span className="spinner"></span>Checking signatures…</span>
              <span className="verify-ok">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path pathLength={1} d="M8.2 12.4l2.6 2.6 5-5.2" /></svg>
                Verified · signed by both authors · history intact
              </span>
            </span>
            <span className="proof">Proof <Icon name="arrow" /></span>
          </div>
        </article>

        <div className="margin-col">
          <div className="mcard glass note" style={{ ["--k" as string]: 0 }}>
            <div className="mcard-head"><span className="avatar">CO</span><b>C. Okafor</b>· on the abstract</div>
            <p>Does the 11 percent hold on the 800-prompt split as well?</p>
            <div className="mcard-foot"><Icon name="message" />2 replies · <Icon name="key" />signed</div>
          </div>
          <div className="mcard" style={{ ["--k" as string]: 1 }}>
            <div className="mcard-head"><Icon name="clipboard" /><b>Formal review</b>· Reviewer 2</div>
            <div className="rmini">
              <div>Soundness <span className="pips"><i className="f"></i><i className="f"></i><i className="f"></i><i className="f"></i><i></i></span></div>
              <div>Evidence <span className="pips"><i className="f"></i><i className="f"></i><i className="f"></i><i className="f"></i><i></i></span></div>
              <div>Reproducibility <span className="pips"><i className="f"></i><i className="f"></i><i className="f"></i><i></i><i></i></span></div>
            </div>
            <div className="mcard-foot"><Icon name="eye-off" />Anonymous to authors · accountable</div>
          </div>
          <div className="mcard ai" style={{ ["--k" as string]: 2 }}>
            <span className="ai-tag"><Icon name="sparkle" />AI pre-review · advisory</span>
            <p>Reference [14] does not resolve to a known work.</p>
            <div className="mcard-foot">¶ 6.2 · confidence 0.92</div>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Illustration: a paper page on Scholium. The paper shows its Reviewed status, its sch: identifier and a Verified badge. In the margin beside it sit a reader&apos;s note on a highlighted sentence, a formal review scored against a rubric, and an advisory AI pre-review finding.
      </figcaption>
    </figure>
  );
}

export default HeroStage;
