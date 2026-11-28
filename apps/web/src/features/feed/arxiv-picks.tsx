import Link from "next/link";

import catalog from "./arxiv-2026.json";

const publishedDate = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function ArxivPaperList({
  papers,
  showAuthors = false,
}: {
  papers: typeof catalog.papers;
  showAuthors?: boolean;
}) {
  return (
    <ul className="fd-list">
      {papers.map(({ id, title, date, authors }) => (
        <li key={id} className="fd-row">
          <h3 className="fd-row-title">
            <a href={`https://arxiv.org/abs/${id}`}>{title}</a>
          </h3>
          <div className="fd-row-meta">
            {showAuthors && (
              <span>
                {authors.slice(0, 4).join(", ")}{authors.length > 4 ? " et al." : ""}
              </span>
            )}
            <time dateTime={date}>{publishedDate.format(new Date(date))}</time>
            {showAuthors && <span>arXiv:{id}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ArxivPicks() {
  return (
    <section aria-labelledby="arxiv-picks-heading">
      <div className="fd-category-head">
        <h2 id="arxiv-picks-heading" className="fd-row-title">arXiv picks</h2>
        <Link className="fd-category-feed" href="/papers/arxiv">
          Browse and search {catalog.papers.length} papers
        </Link>
      </div>
      <ArxivPaperList papers={catalog.papers.slice(0, 6)} />
    </section>
  );
}
