/**
 * `dashboard` — the signed-in member's home screen (`/me`).
 *
 * The feature owns the route group `app/(dashboard)/` and this module.
 *
 * ```tsx
 * import { ME_PATH, DashboardPage } from "@/features/dashboard";
 *
 * <DashboardPage />
 * ```
 */

export {
  ME_PATH,
  DASHBOARD_PATH,
  DASHBOARD_ENDPOINT,
  ME_DASHBOARD_ENDPOINT,
  ME_TITLE,
  DASHBOARD_TITLE,
  SIGNIN_HREF,
  DashboardError,
  MeError,
  MeDashboardError,
  parseDashboard,
  describeDashboardError,
  describeMeError,
  describeMeDashboardError,
  loadDashboard,
  loadMe,
  loadMeDashboard,
  type AttentionItem,
  type DashboardClient,
  type DashboardData,
  type LoadDashboard,
  type MeData,
  type MeDashboardData,
  type MyPaper,
  type MyReview,
  type NeedsAttention,
} from "./dashboard";

export {
  DashboardPage,
  MePage,
  MeDashboardPage,
  Dashboard,
  type DashboardPageProps,
} from "./dashboard-page";