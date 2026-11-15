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
 */
export default function SubmitPage() {
  return <SubmitWizard />;
}
