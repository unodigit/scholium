import type { ReactNode } from "react";

/**
 * One dashboard card. `anchor` is set where another screen deep-links to it
 * (`/me#saved-searches`).
 *
 * Lives in its own module so a card in another file can use it without
 * importing {@link DashboardPage}, which imports those cards in turn.
 */
export function Card({
  title,
  anchor,
  children,
}: {
  title: string;
  anchor?: string;
  children: ReactNode;
}) {
  const headingId = `db-${anchor ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-title`;
  return (
    <section className="db-card" id={anchor} aria-labelledby={headingId}>
      <h2 className="db-card-title" id={headingId}>
        {title}
      </h2>
      <div className="db-card-body">{children}</div>
    </section>
  );
}
