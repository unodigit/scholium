/**
 * `components/footer` — the site footer.
 *
 * The root layout (`app/layout.tsx`) renders {@link SiteFooter} once under
 * every page; route-group layouts do not mount it themselves.
 *
 * ```tsx
 * import { SiteFooter } from "../components/footer";
 * ```
 */

export {
  PUBLIC_EXPORT_PATH,
  SITE_FOOTER_DESCRIPTION,
  SiteFooter,
  publicExportHref,
} from "./site-footer";
