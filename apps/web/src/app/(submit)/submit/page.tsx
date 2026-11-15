import type { Metadata } from "next";

import { SubmitWizard } from "../../../features/submit";

export const metadata: Metadata = {
  title: "Submit a paper · Scholium",
  description:
    "Submit a paper to Scholium: upload your PDF, LaTeX source, code and data, then add details, authors and sign.",
};

/**
 * `/submit` — the five-step submit wizard.
 *
 * Step 1 (Files) takes the PDF and/or LaTeX source plus optional code and
 * data, uploads each resumably and fingerprints it on the author's device.
 * Step 2 (Details) takes the title, abstract, categories and licence.
 * Step 3 (Authors) takes co-authors by DID, ORCID iD or email with their CRediT
 * roles and byline order, and shows a consent tracker (Waiting, Signed or
 * Declined).
 * Step 4 (Checks) shows the version's file safety, references resolved,
 * similarity and metadata match, live while the node is still working, with a
 * place to fix each problem.
 */
export default function SubmitPage() {
  return <SubmitWizard />;
}
