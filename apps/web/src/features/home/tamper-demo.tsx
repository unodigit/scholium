"use client";

import { useState, type CSSProperties } from "react";

import { Icon } from "./icons";
import { useReveal } from "./reveal";
import "./home.css";
import "./provenance.css";

const VERDICT_OK = "Verified. History intact, signed by every author.";
const VERDICT_BAD =
  "Verification failed. v2 no longer matches what its authors signed.";

function ChainLink({ k, broken = false }: { k: number; broken?: boolean }) {
  return (
    <div
      className={broken ? "link brk" : "link"}
      style={{ "--k": k } as CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox="0 0 56 24" aria-hidden="true" focusable="false">
        <path className="lk" pathLength={1} d="M6 12H48M42 6l6 6-6 6" />
      </svg>
      {broken ? (
        <span className="link-x">
          <Icon name="x" />
        </span>
      ) : null}
    </div>
  );
}

/**
 * The Provenance section's interactive proof: three signed versions joined
 * into a chain. Changing one byte of v2 swaps its fingerprint, breaks the
 * v2 → v3 link and flips the verdict; pressing again restores the record.
 */
export function TamperDemo() {
  const [tampered, setTampered] = useState(false);
  const ref = useReveal<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className="demo reveal"
      id="chain"
      data-state={tampered ? "bad" : "ok"}
    >
      <div className="chain">
        <div className="block" style={{ "--k": 0 } as CSSProperties}>
          <div className="block-top">
            <span className="vtag">v1</span>
            <time dateTime="2026-03-12">12 Mar 2026</time>
          </div>
          <dl>
            <dt>Fingerprint</dt>
            <dd>bafy…k3f9</dd>
            <dt>Previous</dt>
            <dd>—</dd>
          </dl>
          <p className="signer">
            <Icon name="key" />
            Signed by 2 of 2 authors
          </p>
        </div>

        <ChainLink k={0} />

        <div className="block v2" style={{ "--k": 1 } as CSSProperties}>
          <div className="block-top">
            <span className="vtag">v2</span>
            <time dateTime="2026-04-02">2 Apr 2026</time>
          </div>
          <dl>
            <dt>Fingerprint</dt>
            <dd>
              <span className="cid">
                <span className="ok" aria-hidden={tampered ? true : undefined}>
                  bafy…q2xz
                </span>
                <span className="bad" aria-hidden={tampered ? undefined : true}>
                  bafy…9e7c
                </span>
              </span>
            </dd>
            <dt>Previous</dt>
            <dd>bafy…k3f9</dd>
          </dl>
          <p className="signer">
            <Icon name="key" />
            <span className="ok-t">Signed by 2 of 2 authors</span>
            <span className="bad-t">Signature no longer matches</span>
          </p>
        </div>

        <ChainLink k={1} broken />

        <div className="block" style={{ "--k": 2 } as CSSProperties}>
          <div className="block-top">
            <span className="vtag">v3</span>
            <time dateTime="2026-05-19">19 May 2026</time>
          </div>
          <dl>
            <dt>Fingerprint</dt>
            <dd>bafy…7mwd</dd>
            <dt>Previous</dt>
            <dd>
              <span className="prev">bafy…q2xz</span>
              <span className="neq">≠</span>
            </dd>
          </dl>
          <p className="signer">
            <Icon name="key" />
            Signed by 2 of 2 authors
          </p>
        </div>
      </div>

      <div className="demo-bar">
        <p className="verdict" aria-live="polite" aria-atomic="true">
          <span className="v-ok" hidden={tampered}>
            <Icon name="check-circle" />
            {VERDICT_OK}
          </span>
          <span className="v-bad" hidden={!tampered}>
            <Icon name="x-circle" />
            {VERDICT_BAD}
          </span>
        </p>
        <button
          type="button"
          className="btn btn-tinted"
          aria-pressed={tampered}
          aria-controls="chain"
          onClick={() => setTampered((value) => !value)}
        >
          <span>{tampered ? "Restore v2" : "Change one byte in v2"}</span>
        </button>
      </div>
    </div>
  );
}

export { VERDICT_BAD, VERDICT_OK };
export default TamperDemo;
