/**
 * `components/nav` — the global navigation.
 *
 * The public surface for app shells (feed, search, submit, dashboard…):
 * mount {@link GlobalNav} once per route-group layout, plus
 * {@link NavTabBarSpacer} under page content so nothing hides behind the
 * fixed mobile bar. Auth screens (`(web-auth)`) stay bare on purpose.
 *
 * ```tsx
 * import { GlobalNav, NavTabBarSpacer } from "../../components/nav";
 * ```
 */

export {
  GlobalNav,
  NavTabBarSpacer,
  NOTIFICATIONS_PATH,
  type GlobalNavProps,
  type LoadNotifications,
} from "./global-nav";

export {
  DEFAULT_CATEGORIES,
  categoryHref,
  type NavCategory,
} from "./categories";

export {
  NOTIFICATIONS_CHANGED_EVENT,
  countUnread,
  type NavNotification,
} from "./notifications";

export { useSignedIn } from "./session";
