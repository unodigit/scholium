"use client";

/**
 * The global navigation — `docs/design.md` §4 (IA), §5.1 (feed header), §10.
 *
 * One component, two shapes, decided by the 640px breakpoint:
 *
 * - ≥640px: a sticky translucent header — `scholium` wordmark · search field ·
 *   Categories · Submit · notifications · avatar · Sign out.
 * - <640px: a fixed bottom tab bar — Home · Search · Submit · Inbox · Me, plus
 *   Sign out while signed in.
 *
 * Mount it once in a route-group layout and keep auth screens bare:
 *
 * ```tsx
 * import { GlobalNav, NavTabBarSpacer } from "../../components/nav";
 *
 * <>
 *   <GlobalNav />
 *   <main>{children}</main>
 *   <NavTabBarSpacer />{" "}
 *   {/* keeps content clear of the fixed bar on phones *\/}
 * </>
 * ```
 *
 * Every part works with no props: sign-in state is read from the shared token
 * store, the unread badge is fetched from `GET /v1/me/notifications` when
 * signed in, and the Categories menu lists the launch taxonomy. Props exist so
 * shell owners (or tests) can pin any of it.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { api } from "../../lib/api";
import {
  categoryHref,
  DEFAULT_CATEGORIES,
  type NavCategory,
} from "./categories";
import {
  BellIcon,
  ChevronDownIcon,
  HomeIcon,
  PersonIcon,
  PlusIcon,
  SearchIcon,
  SignOutIcon,
} from "./icons";
import { countUnread } from "./notifications";
import { useSignedIn, useSignOut } from "./session";
import "./nav.css";

/** Where the notifications card lives (design.md §4: Dashboard → Notifications). */
export const NOTIFICATIONS_PATH = "/me#notifications";

/** Placeholder from the feed header mock (design.md §5.1). */
const SEARCH_PLACEHOLDER = "Search papers, authors, sch: IDs…";

/** Search input label; same words as the placeholder, minus the ellipsis. */
const SEARCH_LABEL = "Search papers, authors and sch: IDs";

/** Reads the unread count for the badge; replaceable in tests. */
export type LoadNotifications = () => Promise<unknown>;

const defaultLoadNotifications: LoadNotifications = () =>
  api.get("/me/notifications");

/** Badge text: the count itself, capped for width. */
function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** `true` when `pathname` is `prefix` or inside it (`/search`, `/search?q=…`). */
function isInside(pathname: string | null, prefix: string): boolean {
  if (!pathname) {
    return false;
  }
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The current URL hash, client-side only ("" on the server and first paint). */
function useHash(): string {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const update = (): void => setHash(window.location.hash);
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
}

/** Props for {@link GlobalNav}. Everything is optional. */
export interface GlobalNavProps {
  /** Categories for the desktop menu; defaults to the launch set. */
  categories?: readonly NavCategory[];
  /**
   * Unread notifications for the badge. When omitted and signed in, the count
   * is fetched once from `GET /v1/me/notifications` (failures are silent —
   * the badge is a courtesy, not a gate).
   */
  unreadCount?: number;
  /**
   * Pin the sign-in state (`true`/`false`). When omitted it is derived from
   * the shared token store after mount.
   */
  signedIn?: boolean;
  /** Display name for the avatar's initials; without one the avatar falls
   * back to a person glyph. */
  displayName?: string;
  /** Placeholder of the search field. */
  searchPlaceholder?: string;
  /**
   * Replace how the unread count is loaded; `null` disables fetching
   * entirely (with `unreadCount` that makes the nav fully offline).
   */
  loadNotifications?: LoadNotifications | null;
}

/** The global navigation: desktop header + mobile tab bar. */
export function GlobalNav({
  categories = DEFAULT_CATEGORIES,
  unreadCount,
  signedIn,
  displayName,
  searchPlaceholder = SEARCH_PLACEHOLDER,
  loadNotifications,
}: GlobalNavProps) {
  const storeSignedIn = useSignedIn(signedIn);
  const effectiveSignedIn = signedIn ?? storeSignedIn;
  const { signingOut, signOut } = useSignOut();

  const load =
    loadNotifications === undefined
      ? defaultLoadNotifications
      : loadNotifications;

  const [fetchedUnread, setFetchedUnread] = useState<number | null>(null);
  useEffect(() => {
    if (unreadCount !== undefined || !effectiveSignedIn || !load) {
      return;
    }
    let active = true;
    load()
      .then((rows) => {
        if (active) {
          setFetchedUnread(countUnread(rows));
        }
      })
      .catch(() => {
        // Offline or signed-out mid-flight: no badge, no error surface.
      });
    return () => {
      active = false;
    };
  }, [unreadCount, effectiveSignedIn, load]);

  const unread = unreadCount ?? fetchedUnread ?? 0;

  return (
    <>
      <DesktopHeader
        categories={categories}
        unread={unread}
        signedIn={effectiveSignedIn}
        displayName={displayName}
        searchPlaceholder={searchPlaceholder}
        signingOut={signingOut}
        onSignOut={signOut}
      />
      <MobileTabBar
        unread={unread}
        signedIn={effectiveSignedIn}
        signingOut={signingOut}
        onSignOut={signOut}
      />
    </>
  );
}

export default GlobalNav;

/** Empty block matching the fixed mobile tab bar, so content clears it. */
export function NavTabBarSpacer() {
  return <div className="gn-tabbar-spacer sm:hidden" aria-hidden="true" />;
}

/* ---- Desktop header -------------------------------------------------------- */

function DesktopHeader({
  categories,
  unread,
  signedIn,
  displayName,
  searchPlaceholder,
  signingOut,
  onSignOut,
}: {
  categories: readonly NavCategory[];
  unread: number;
  signedIn: boolean;
  displayName?: string;
  searchPlaceholder: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const router = useRouter();

  // Soft-navigate on submit; the `action` keeps the form working without JS.
  const onSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("q");
    const q = typeof value === "string" ? value.trim() : "";
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  };

  const bellLabel =
    unread > 0 ? `Notifications, ${badgeText(unread)} unread` : "Notifications";

  return (
    <header className="gn-header material-chrome hidden sm:flex">
      <Link href="/" className="gn-wordmark">
        scholium
      </Link>

      <form
        className="gn-search"
        role="search"
        action="/search"
        method="get"
        onSubmit={onSearchSubmit}
      >
        <button type="submit" className="gn-search-submit" aria-label="Search">
          <SearchIcon size={16} />
        </button>
        <input
          className="gn-search-input"
          type="search"
          name="q"
          placeholder={searchPlaceholder}
          aria-label={SEARCH_LABEL}
        />
      </form>

      <CategoryMenu categories={categories} />

      <Link href="/submit" className="gn-submit">
        Submit
      </Link>

      <Link
        href={signedIn ? NOTIFICATIONS_PATH : "/signin"}
        className="gn-icon-button"
        aria-label={bellLabel}
      >
        <BellIcon />
        {unread > 0 ? (
          <span className="gn-badge" aria-hidden="true">
            {badgeText(unread)}
          </span>
        ) : null}
      </Link>

      <AvatarLink signedIn={signedIn} displayName={displayName} />

      {signedIn ? (
        <button
          type="button"
          className="gn-signout"
          onClick={onSignOut}
          disabled={signingOut}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      ) : null}
    </header>
  );
}

/** The Categories disclosure: trigger + links to `/c/{id}` pages. */
function CategoryMenu({ categories }: { categories: readonly NavCategory[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="gn-menu-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="gn-link"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Categories
        <ChevronDownIcon
          size={16}
          className={open ? "gn-chevron gn-chevron--open" : "gn-chevron"}
        />
      </button>
      {open ? (
        <div className="gn-menu">
          <ul className="gn-menu-list">
            {categories.map((category) => (
              <li key={category.id}>
                <Link
                  href={categoryHref(category)}
                  className="gn-menu-item"
                  onClick={() => setOpen(false)}
                >
                  <span>{category.label}</span>
                  <span className="gn-menu-id">{category.id}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Initials for the signed-in avatar; `null` renders the person glyph. */
function initialsFrom(name: string | undefined): string | null {
  if (!name) {
    return null;
  }
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? "" : "";
  const initials = `${first}${last}`.toUpperCase();
  return initials || null;
}

/** The avatar: initials to `/me`, or a guest glyph to `/signin`. */
function AvatarLink({
  signedIn,
  displayName,
}: {
  signedIn: boolean;
  displayName?: string;
}) {
  const initials = signedIn ? initialsFrom(displayName) : null;
  return (
    <Link
      href={signedIn ? "/me" : "/signin"}
      className="gn-icon-button"
      aria-label={signedIn ? "Your dashboard" : "Sign in"}
    >
      <span
        className={
          initials ? "gn-avatar" : "gn-avatar gn-avatar--guest"
        }
        aria-hidden="true"
      >
        {initials ?? <PersonIcon size={18} />}
      </span>
    </Link>
  );
}

/* ---- Mobile tab bar -------------------------------------------------------- */

/** One tab of the bottom bar. */
interface TabSpec {
  key: string;
  label: string;
  href: string;
  icon: typeof HomeIcon;
  current: boolean;
  badge?: string;
}

/** Home · Search · Submit · Inbox · Me, then Sign out while signed in. */
function MobileTabBar({
  unread,
  signedIn,
  signingOut,
  onSignOut,
}: {
  unread: number;
  signedIn: boolean;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const pathname = usePathname();
  const hash = useHash();
  const meHere = isInside(pathname, "/me");
  const inboxHere = meHere && hash === "#notifications";
  const badge = unread > 0 ? badgeText(unread) : undefined;

  const tabs: readonly TabSpec[] = [
    {
      key: "home",
      label: "Home",
      href: "/",
      icon: HomeIcon,
      current: pathname === "/",
    },
    {
      key: "search",
      label: "Search",
      href: "/search",
      icon: SearchIcon,
      current: isInside(pathname, "/search"),
    },
    {
      key: "submit",
      label: "Submit",
      href: "/submit",
      icon: PlusIcon,
      current: isInside(pathname, "/submit"),
    },
    {
      key: "inbox",
      label: "Inbox",
      href: signedIn ? NOTIFICATIONS_PATH : "/signin",
      icon: BellIcon,
      current: inboxHere,
      badge,
    },
    {
      key: "me",
      label: "Me",
      href: signedIn ? "/me" : "/signin",
      icon: PersonIcon,
      current: meHere && !inboxHere,
    },
  ];

  return (
    <nav
      className="gn-tabbar material-chrome flex sm:hidden"
      aria-label="Primary"
    >
      {tabs.map(({ key, label, href, icon: Icon, current, badge: tabBadge }) => (
        <Link
          key={key}
          href={href}
          className="gn-tab"
          aria-current={current ? "page" : undefined}
        >
          <span className="gn-tab-icon">
            <Icon size={22} />
            {tabBadge ? (
              <span className="gn-badge" aria-hidden="true">
                {tabBadge}
              </span>
            ) : null}
          </span>
          <span className="gn-tab-label">{label}</span>
        </Link>
      ))}

      {signedIn ? (
        <button
          type="button"
          className="gn-tab gn-tab--action"
          onClick={onSignOut}
          disabled={signingOut}
        >
          <span className="gn-tab-icon">
            <SignOutIcon size={22} />
          </span>
          <span className="gn-tab-label">
            {signingOut ? "Signing out…" : "Sign out"}
          </span>
        </button>
      ) : null}
    </nav>
  );
}
