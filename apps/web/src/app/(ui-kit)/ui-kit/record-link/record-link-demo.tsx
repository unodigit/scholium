"use client";

import {
  RecordLink,
  type RecordLoader,
} from "../../../../features/ui-kit";
import { ApiError } from "../../../../lib/api";

/** A stored envelope in the shape `GET /v1/records/{cid}` serves. */
const SAMPLE_CID =
  "bafyreihbppt2cuitohaqvn5j2xz6qk5e4h5f2n7hs3w6m4a5g2t2xw3y4z5a";

const SAMPLE_RECORD = {
  v: 1,
  type: "paper.version",
  author: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
  created: "2026-11-14T05:33:00Z",
  prev: null,
  body: {
    paper: "sch:9f2c1a7e",
    version: 2,
    title: "Can a Meta-Agent Choose the Safer Branch?",
    categories: ["cs.AI", "cs.MA"],
    content: {
      html: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
      pdf: "bafkreig7lqo4n4z5gf4wz5b2y5m3x4z5a6b7c8d9e0f1g2h3i4j5k6l7m8",
    },
  },
  proofs: [],
  id: SAMPLE_CID,
};

/** Stands in for the API in the gallery: the sheet reads this on open. */
const sampleLoader: RecordLoader = async () => SAMPLE_RECORD;

/** A record the server does not have, for the failure state. */
const missingRecordLoader: RecordLoader = async () => {
  throw new ApiError(404, { status: 404 });
};

/**
 * Live examples for `/ui-kit/record-link`.
 *
 * A loader is a function, so this gallery is a client component: in the app
 * the default loader is `GET /v1/records/{cid}`, which the sheet calls when it
 * opens.
 */
export function RecordLinkDemo() {
  return (
    <div className="uk-examples">
      <article className="uk-panel">
        <h3>In a paper page</h3>
        <p className="uk-note">
          The trigger reads the record when it opens the sheet. The JSON here is
          the sample envelope; in the app it is the exact body of{" "}
          <code>GET /v1/records/&#123;cid&#125;</code>.
        </p>
        <RecordLink cid={SAMPLE_CID} loadRecord={sampleLoader} />
      </article>

      <article className="uk-panel">
        <h3>In a version history</h3>
        <p className="uk-note">
          The label can name the version without changing the sheet or the
          request.
        </p>
        <RecordLink
          cid={SAMPLE_CID}
          label="View this version"
          loadRecord={sampleLoader}
        />
      </article>

      <article className="uk-panel">
        <h3>When the record is missing</h3>
        <p className="uk-note">
          The sheet says one plain sentence and offers one retry. It never shows
          a partial record.
        </p>
        <RecordLink
          cid={SAMPLE_CID}
          label="View a missing record"
          loadRecord={missingRecordLoader}
        />
      </article>

      <article className="uk-panel" data-theme="dark">
        <h3>Dark theme</h3>
        <p className="uk-note">
          The trigger, scrim and sheet read the design tokens, so a{" "}
          <code>data-theme=&quot;dark&quot;</code> subtree re-themes them.
        </p>
        <RecordLink cid={SAMPLE_CID} loadRecord={sampleLoader} />
      </article>
    </div>
  );
}
