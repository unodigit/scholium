import { AiPrereviewSection } from "./ai-prereview";
import { CompareSection } from "./compare";
// The data file owns the bare "./faq" specifier (it resolves to faq.ts, which is
// the point of the split: structured data reuses the same questions), so the
// section is imported through its explicit extension. The ts-expect-error
// silences TS5097, which fires exactly because the two files share a basename.
// @ts-expect-error "./faq.tsx" needs its extension to be importable at all
import { FaqSection } from "./faq.tsx";
import { FactsStrip } from "./facts-strip";
import { FinalCta } from "./final-cta";
import { Hero } from "./hero";
import { HowItWorksSection } from "./how-it-works";
import { NameSection } from "./name-section";
import { OpenReviewSection } from "./open-review";
import { PrinciplesSection } from "./principles";
import { ProvenanceSection } from "./provenance";
import { RevealScan } from "./reveal-scan";
import { RolesSection } from "./roles";
import { Statement } from "./statement";
import { VerifyBand } from "./verify-band";

/**
 * The homepage's sections, in the order of the reference
 * (`docs/homepage/index.html`, docs/design.md §5.9):
 *
 *  1. Hero (`#top`)
 *  2. Facts strip
 *  3. Why Scholium, the statement
 *  4. Provenance (`#signed`)
 *  5. Open review (`#review`)
 *  6. AI pre-review (`#ai`)
 *  7. Verify (`#verify`)
 *  8. Who it's for (`#who`)
 *  9. How it works (`#how`)
 * 10. Compare (`#compare`)
 * 11. Principles (`#principles`)
 * 12. Name (`#name`)
 * 13. FAQ (`#faq`)
 * 14. Final call to action
 *
 * The page is a fragment: the `(home)` layout supplies the navigation bar and
 * the `<main>` landmark, and the root layout's site footer follows. A server
 * component, so the sections without state render on the server only and the
 * rest hydrate where they are. Every word is in the server-rendered HTML.
 *
 * `RevealScan` renders nothing: it hands every block the page reveals on scroll
 * to the shared observer, so none stays hidden under `html[data-home-js]`.
 */
export function HomePage() {
  return (
    <>
      <Hero />
      <FactsStrip />
      <Statement />
      <ProvenanceSection />
      <OpenReviewSection />
      <AiPrereviewSection />
      <VerifyBand />
      <RolesSection />
      <HowItWorksSection />
      <CompareSection />
      <PrinciplesSection />
      <NameSection />
      <FaqSection />
      <FinalCta />
      <RevealScan />
    </>
  );
}

export default HomePage;
