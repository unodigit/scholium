"use client";

import {
  DecisionBanner,
  RecordLink,
  type RecordLoader,
} from "../../../../features/ui-kit";

/**
 * Sample envelopes in the shape `GET /v1/records/{cid}` serves: a
 * retraction notice, a correction notice, the newest version, and the
 * tombstone's moderation decision. Each banner's "View record" opens its
 * own record; the cids are the sample envelope ids.
 */
const RETRACTION_CID =
  "bafyreihbppt2cuitohaqvn5j2xz6qk5e4h5f2n7hs3w6m4a5g2t2xw3y4z5a";
const CORRECTION_CID =
  "bafyreicq7m2y4z5a6b7c8d9e0f1g2h3i4j5k6l7m8n9o0p1q2r3s4t5u6v7w";
const NEWEST_CID =
  "bafyreidh5f2n7hs3w6m4a5g2t2xw3y4z5a6b7c8d9e0f1g2h3i4j5k6l7m8n9o0p1";
const TOMBSTONE_CID =
  "bafyreie8n9o0p1q2r3s4t5u6v7w8x9y0z1a2b3c4d5e6f7g8h9i0j1k2l3m4n5";

const AUTHOR = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const RETRACTION = {
  v: 1,
  type: "retraction",
  author: AUTHOR,
  created: "2027-05-04T09:12:00Z",
  prev: null,
  body: {
    target: "sch:k3f9-q2xz-7mwd/v2",
    reason: "The results in Figure 3 cannot be reproduced from the published data.",
    replacement: null,
  },
  proofs: [],
  id: RETRACTION_CID,
};

const CORRECTION = {
  v: 1,
  type: "correction",
  author: AUTHOR,
  created: "2027-03-18T16:40:00Z",
  prev: null,
  body: {
    target: "sch:k3f9-q2xz-7mwd/v1",
    reason:
      "The y-axis of Figure 2 was mislabelled. The correction is on record and v2 carries the fix.",
    replacement: "sch:k3f9-q2xz-7mwd/v2",
  },
  proofs: [],
  id: CORRECTION_CID,
};

const NEWEST_VERSION = {
  v: 1,
  type: "paper.version",
  author: AUTHOR,
  created: "2027-05-30T11:02:00Z",
  prev: null,
  body: {
    paper: "sch:k3f9-q2xz-7mwd",
    n: 3,
    title: "Can a Meta-Agent Choose the Safer Branch?",
    changeNote: "Adds the ablation study reviewers asked for.",
  },
  proofs: [],
  id: NEWEST_CID,
};

const TOMBSTONE_DECISION = {
  v: 1,
  type: "moderation.decision",
  author: AUTHOR,
  created: "2027-05-04T08:00:00Z",
  prev: null,
  body: {
    target: "sch:k3f9-q2xz-7mwd/v2",
    action: "tombstone",
    clause: "MOD-05",
    reason:
      "Unlawful in the node's operating jurisdiction. The bytes are deleted; the envelope and log entry remain.",
  },
  proofs: [],
  id: TOMBSTONE_CID,
};

const recordOf = (record: unknown): RecordLoader => async () => record;

/** All four banners, with the record links reading the samples above. */
function AllBanners() {
  return (
    <>
      <DecisionBanner
        kind="retracted"
        recordCid={RETRACTION_CID}
        clause="MOD-03"
        reason={RETRACTION.body.reason}
        loadRecord={recordOf(RETRACTION)}
      />
      <DecisionBanner
        kind="corrected"
        recordCid={CORRECTION_CID}
        reason={CORRECTION.body.reason}
        loadRecord={recordOf(CORRECTION)}
      />
      <DecisionBanner
        kind="newer_version"
        recordCid={NEWEST_CID}
        versionHref="/papers/sch:k3f9-q2xz-7mwd/v3"
        versionLabel="v3"
        loadRecord={recordOf(NEWEST_VERSION)}
      />
      <DecisionBanner
        kind="removed_legal"
        recordCid={TOMBSTONE_CID}
        clause="MOD-05"
        category="Unlawful content"
        removedOn="4 May 2027"
        loadRecord={recordOf(TOMBSTONE_DECISION)}
      />
    </>
  );
}

/**
 * Live examples for `/ui-kit/decision-banner`.
 *
 * A `loadRecord` function is a prop, so this gallery is a client component:
 * in the app the default loader reads `GET /v1/records/{cid}`, and the
 * record link opens the sheet without the page navigating away.
 */
export function DecisionBannerDemo() {
  return (
    <div className="uk-examples">
      <article className="uk-panel">
        <h3>Retracted, with its record and its policy clause</h3>
        <p className="uk-note">
          The notice&rsquo;s own reason is the sentence. &ldquo;View
          record&rdquo; opens the signed retraction;
          &ldquo;Policy MOD-03&rdquo; goes to the clause on{" "}
          <a href="/policies">/policies</a>.
        </p>
        <DecisionBanner
          kind="retracted"
          recordCid={RETRACTION_CID}
          clause="MOD-03"
          reason={RETRACTION.body.reason}
          loadRecord={recordOf(RETRACTION)}
        />
      </article>

      <article className="uk-panel">
        <h3>Corrected, on record alone</h3>
        <p className="uk-note">
          A correction an author signs cites no policy clause, so the banner
          shows the record and the reason — never a link it cannot stand
          behind.
        </p>
        <DecisionBanner
          kind="corrected"
          recordCid={CORRECTION_CID}
          reason={CORRECTION.body.reason}
          loadRecord={recordOf(CORRECTION)}
        />
      </article>

      <article className="uk-panel">
        <h3>A newer version exists</h3>
        <p className="uk-note">
          The way forward comes first — &ldquo;Go to v3&rdquo; — then the
          record of the version it points at.
        </p>
        <DecisionBanner
          kind="newer_version"
          recordCid={NEWEST_CID}
          versionHref="/papers/sch:k3f9-q2xz-7mwd/v3"
          versionLabel="v3"
          loadRecord={recordOf(NEWEST_VERSION)}
        />
      </article>

      <article className="uk-panel">
        <h3>Content removed for legal reasons</h3>
        <p className="uk-note">
          The tombstone sentence of docs/design.md §8, with the removal
          date and the reason category (§5.2). The record of its existence
          remains: the decision is still readable.
        </p>
        <DecisionBanner
          kind="removed_legal"
          recordCid={TOMBSTONE_CID}
          clause="MOD-05"
          category="Unlawful content"
          removedOn="4 May 2027"
          loadRecord={recordOf(TOMBSTONE_DECISION)}
        />
      </article>

      <article className="uk-panel" data-theme="dark">
        <h3>Dark theme</h3>
        <p className="uk-note">
          The banner reads the design tokens, so a{" "}
          <code>data-theme=&quot;dark&quot;</code> subtree re-themes it
          without extra classes.
        </p>
        <DecisionBanner
          kind="retracted"
          recordCid={RETRACTION_CID}
          clause="MOD-03"
          reason={RETRACTION.body.reason}
          loadRecord={recordOf(RETRACTION)}
        />
      </article>

      <article className="uk-panel uk-greyscale">
        <h3>Without colour</h3>
        <p className="uk-note">
          Every colour removed: each banner is still its own icon, its own
          word, and its own sentence. Two are neutral on purpose — a newer
          version and a legal removal are facts, not fault states.
        </p>
        <div className="uk-examples">
          <AllBanners />
        </div>
      </article>
    </div>
  );
}
