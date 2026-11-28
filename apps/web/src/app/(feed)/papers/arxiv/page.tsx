import type { Metadata } from "next";
import Link from "next/link";

import catalog from "../../../../features/feed/arxiv-2026.json";
import { ArxivPaperList } from "../../../../features/feed/arxiv-picks";
import "../../../../features/feed/feed.css";

const PAGE_SIZE = 20;
const PATH = "/papers/arxiv";

export const metadata: Metadata = {
  title: `${catalog.year} arXiv picks`,
  description: "Browse and search arXiv papers selected from Hugging Face Daily Papers.",
  alternates: { canonical: PATH },
};

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function pageHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  return params.size ? `${PATH}?${params}` : PATH;
}

export default async function ArxivCatalogPage({
  searchParams,
}: {
  searchParams?: Promise<{ q?: string | string[]; page?: string | string[] }>;
}) {
  const params = await searchParams;
  const query = typeof params?.q === "string" ? params.q.trim().slice(0, 200) : "";
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const matches = words.length ? catalog.papers.filter(({ title, authors, id }) => {
    const text = normalize(`${title} ${authors.join(" ")} arXiv:${id}`);
    return words.every((word) => text.includes(word));
  }) : catalog.papers;

  const lastPage = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const rawPage = typeof params?.page === "string" && /^\d+$/.test(params.page)
    ? Number(params.page)
    : 1;
  const page = Math.max(1, Math.min(rawPage, lastPage));
  const start = (page - 1) * PAGE_SIZE;
  const visible = matches.slice(start, start + PAGE_SIZE);

  return (
    <div className="fd-page">
      <header className="fd-category-header">
        <h1 className="fd-category-title">{catalog.year} arXiv picks</h1>
        <p className="fd-category-lede">
          Selected from{" "}
          <a href="https://huggingface.co/papers">Hugging Face Daily Papers</a>{" "}
          through <time dateTime={catalog.selectedOn}>{catalog.selectedOn}</time>.
        </p>
      </header>
      <form className="fd-arxiv-search" action={PATH} method="get" role="search" aria-label="arXiv papers">
        <label className="fd-select">
          <span className="fd-select-label">Title, author, or arXiv ID</span>
          <input name="q" type="search" defaultValue={query} maxLength={200} />
        </label>
        <button className="fd-button" type="submit">Search</button>
        {query && <Link className="fd-category-feed" href={PATH}>Clear search</Link>}
      </form>
      <section aria-labelledby="arxiv-results">
        <h2 id="arxiv-results" className="fd-row-title">
          {matches.length === 0
            ? "No matching papers"
            : "Papers"}
        </h2>
        <ArxivPaperList papers={visible} showAuthors />
      </section>
      {lastPage > 1 && (
        <nav className="fd-category-actions" aria-label="arXiv result pages">
          {page > 1 && <Link className="fd-category-feed" href={pageHref(query, page - 1)}>Previous</Link>}
          <span className="fd-category-lede">Page {page} of {lastPage}</span>
          {page < lastPage && <Link className="fd-category-feed" href={pageHref(query, page + 1)}>Next</Link>}
        </nav>
      )}
    </div>
  );
}
