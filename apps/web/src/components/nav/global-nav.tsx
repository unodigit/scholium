"use client";

/**
 * The global navigation — `docs/design.md` §4 (IA), §5.1 (feed header), §10.
 *
 * One component, two shapes, decided by the 640px breakpoint:
 *
 * - ≥640px: a sticky translucent header — Scholium lockup · search field ·
 *   Categories · Submit · notifications · avatar · Sign out.
 * - <640px: a fixed bottom tab bar — Home · Search · Submit · Inbox · Me, plus
 *   Sign out while signed in. The Home tab carries the brand's tile mark
 *   because the wordmark does not fit at phone widths.
 *
 * The lockup and the Home tab point at the feed (`/papers`): `/` is the
 * homepage, which brings its own navigation.
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
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";

import { BrandLogo } from "../../features/ui-kit/brand-logo";
import { BrandMark } from "../../features/ui-kit/brand-mark";
import { api, tokenStore } from "../../lib/api";
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
import { countUnread, NOTIFICATIONS_CHANGED_EVENT } from "./notifications";
import { useSignedIn, useSignOut } from "./session";
import "./nav.css";

/** Where the notifications card lives (design.md §4: Dashboard → Notifications). */
export const NOTIFICATIONS_PATH = "/me#notifications";

/**
 * Mirrors `SEARCH_URL_CHANGED_EVENT` in
 * `features/search-page/search-page.tsx` (the nav does not import from
 * features/); keep the two strings in sync.
 */
export const SEARCH_URL_CHANGED_EVENT = "scholium:search-url-changed";

/**
 * The feed's address. `components/` keeps to `features/ui-kit`, so this mirrors
 * `FEED_PATH` in `features/feed/feed.ts` rather than importing the feed module
 * into the nav every route group mounts.
 */
const FEED_PATH = "/papers";

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

/**
 * The `q` already in the address bar, and a setter for edits.
 *
 * `useSearchParams()` is not used here on purpose: this nav is mounted by
 * several route-group layouts, and a static page that calls it needs a
 * Suspense boundary it does not otherwise have. Reading `location.search`
 * after mount keeps the server HTML and the first client render identical,
 * and a `popstate` listener (plus the pathname in the effect's deps) makes the
 * field follow back/forward and route changes. Before mount the field is
 * empty, exactly as the server rendered it.
 */
export function useSearchQuery(
  inputRef?: RefObject<HTMLInputElement | null>,
): [string, (value: string) => void] {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const read = (): void => {
      setQuery(new URLSearchParams(window.location.search).get("q") ?? "");
    };
    const onSearchUrlChanged = (): void => {
      // Do not overwrite a draft the reader is actively typing in the header
      // box: the field is focused, so leave it alone.
      const focusedInput = inputRef?.current ?? null;
      if (focusedInput !== null && document.activeElement === focusedInput) {
        return;
      }
      read();
    };
    read();
    window.addEventListener("popstate", read);
    window.addEventListener(SEARCH_URL_CHANGED_EVENT, onSearchUrlChanged);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener(SEARCH_URL_CHANGED_EVENT, onSearchUrlChanged);
    };
  }, [pathname, inputRef]);

  return [query, setQuery];
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

/**
 * True while the shared token store holds an access token.
 *
 * `useSignedIn` is also true from the localStorage hint, which is there on a
 * full page load before `POST /v1/auth/refresh` has restored the token. That
 * is enough to pick the nav's actions but not to authorize a request, so the
 * unread count follows this instead: it turns true when the restored token
 * arrives (no token → token) and false when the session's token goes. A
 * rotated token keeps it true, so a refresh does not cause another read.
 * Like `useSignedIn` it starts false, so the first client render matches the
 * server's.
 */
function useHoldsAccessToken(): boolean {
  const [holds, setHolds] = useState(false);
  useEffect(() => {
    const update = (): void => setHolds(tokenStore.isAuthenticated);
    update();
    return tokenStore.subscribe(update);
  }, []);
  return holds;
}

/** Props for {@link GlobalNav}. Everything is optional. */
export interface GlobalNavProps {
  /** Categories for the desktop menu; defaults to the launch set. */
  categories?: readonly NavCategory[];
  /**
   * Unread notifications for the badge. When omitted and signed in, the count
   * is fetched from `GET /v1/me/notifications` once an access token is held —
   * after a full page load that is when the session is restored, not when the
   * signed-in hint is read — and again if the token goes and comes back
   * (failures are silent — the badge is a courtesy, not a gate).
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
  const holdsToken = useHoldsAccessToken();
  // Which actions show follows the sign-in state, hint included. The count is
  // a request, so it also needs the access token to be in memory: on a full
  // page load the hint is true well before the token is restored, and a read
  // made in that gap is refused with a 401 the client cannot refresh (it sent
  // no credentials) and nothing would ever repeat it. A shell that pins
  // `signedIn` has made that call itself and is taken at its word.
  const hasSession =
    effectiveSignedIn && (signedIn !== undefined || holdsToken);
  const { signingOut, signOut } = useSignOut();

  const load =
    loadNotifications === undefined
      ? defaultLoadNotifications
      : loadNotifications;

  const [fetchedUnread, setFetchedUnread] = useState<number | null>(null);

  // The fetched count belongs to the account that was signed in when it was
  // read. When that session ends (Sign out, or a 401 the client could not
  // refresh) forget it, so the next account on this document never sees it.
  // The badge below is also derived from `hasSession`, which is what makes the
  // signed-out bell appear in the same render as the session ends rather than
  // one effect later.
  useEffect(() => {
    if (!hasSession) {
      setFetchedUnread(null);
    }
  }, [hasSession]);

  // Runs when the session first has a token (a restored one included) and
  // again each time it goes away and comes back; a token that is merely
  // rotated leaves `hasSession` as it was.
  useEffect(() => {
    if (unreadCount !== undefined || !hasSession || !load) {
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
  }, [unreadCount, hasSession, load]);

  // The notifications card marks rows read; this is how the bell hears about
  // it. `detail.unread` is authoritative, so rapid marks do not race the badge.
  useEffect(() => {
    if (unreadCount !== undefined || !hasSession) {
      return;
    }
    const onChanged = (event: Event): void => {
      const unreadNow = (event as CustomEvent<{ unread?: unknown }>).detail
        ?.unread;
      if (typeof unreadNow === "number" && Number.isFinite(unreadNow)) {
        setFetchedUnread(Math.max(0, Math.trunc(unreadNow)));
      }
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    };
  }, [unreadCount, hasSession]);

  // A pinned `unreadCount` is the shell's to decide. Otherwise only a signed-in
  // visitor has a count; a signed-out one has no notifications to be told of.
  const unread = unreadCount ?? (hasSession ? (fetchedUnread ?? 0) : 0);

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
  const pathname = usePathname();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useSearchQuery(searchInputRef);

  // Soft-navigate on submit; the `action` keeps the form working without JS.
  const onSearchSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const q = query.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  };

  const bellLabel =
    unread > 0 ? `Notifications, ${badgeText(unread)} unread` : "Notifications";

  return (
    <header className="gn-header material-chrome hidden sm:flex">
      <Link href={FEED_PATH} className="gn-brand" aria-label="Scholium home">
        <BrandLogo size="sm" />
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
          ref={searchInputRef}
          className="gn-search-input"
          type="search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={searchPlaceholder}
          aria-label={SEARCH_LABEL}
        />
      </form>

      <CategoryMenu categories={categories} />

      <Link
        href="/docs"
        className="gn-link"
        aria-current={isInside(pathname, "/docs") ? "page" : undefined}
      >
        Docs
      </Link>

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
  icon?: typeof HomeIcon;
  /** Home carries the brand tile instead of a house glyph at phone widths. */
  brandMark?: boolean;
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
      href: FEED_PATH,
      brandMark: true,
      current: pathname === FEED_PATH,
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
      {tabs.map(
        ({
          key,
          label,
          href,
          icon: Icon,
          brandMark,
          current,
          badge: tabBadge,
        }) => (
          <Link
            key={key}
            href={href}
            className="gn-tab"
            aria-current={current ? "page" : undefined}
          >
            <span className="gn-tab-icon">
              {brandMark ? (
                <BrandMark
                  variant="tile"
                  size="sm"
                  decorative
                  className="gn-tab-brand"
                  style={{ height: "24px" }}
                />
              ) : Icon ? (
                <Icon size={22} />
              ) : null}
              {tabBadge ? (
                <span className="gn-badge" aria-hidden="true">
                  {tabBadge}
                </span>
              ) : null}
            </span>
            <span className="gn-tab-label">{label}</span>
          </Link>
        ),
      )}

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
