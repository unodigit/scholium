export { HomePage } from "./home-page";
export { HomeNav, type HomeNavProps } from "./home-nav";
export { Hero } from "./hero";
export { FactsStrip } from "./facts-strip";
export { Statement } from "./statement";
export { ProvenanceSection } from "./provenance";
export { OpenReviewSection } from "./open-review";
export { AiPrereviewSection } from "./ai-prereview";
export { VerifyBand } from "./verify-band";
export { RolesSection } from "./roles";
export { HowItWorksSection } from "./how-it-works";
export { CompareSection } from "./compare";
export { PrinciplesSection } from "./principles";
export { NameSection } from "./name-section";
// faq.ts is the data and faq.tsx the section; they share a basename, so each is
// reached by its extension (a bare "./faq" means a different file to Next's
// bundler than to Vite). The ts-expect-error silences TS5097.
// @ts-expect-error "./faq.tsx" needs its extension to be importable at all
export { FaqSection } from "./faq.tsx";
// @ts-expect-error "./faq.ts" needs its extension to be unambiguous
export { FAQ_ENTRIES, type FaqEntry } from "./faq.ts";
export { FinalCta } from "./final-cta";
export { HeroStage } from "./hero-stage";
export { Icon, type IconName, type IconProps } from "./icons";
export { Spring, type SpringOptions } from "./spring";
export { Reveal, useReveal, observeReveal, getRevealObserver } from "./reveal";
export { RevealScan, REVEAL_SELECTOR } from "./reveal-scan";
export {
  HOME_DATE_MODIFIED,
  HOME_DESCRIPTION,
  HOME_FEATURE_LIST,
  HOME_TITLE,
  absoluteUrl,
  homeJsonLd,
  homeMetadata,
  serializeJsonLd,
  type HomeJsonLd,
  type JsonLdNode,
} from "./structured-data";
