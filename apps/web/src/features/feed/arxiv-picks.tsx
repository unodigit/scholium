const papers = [
  {
    id: "2611.29897",
    title: "Motion Mamba 2.0: Autoregressive Diffusion Mamba for Long-Horizon Humanoid Control",
    date: "2026-11-23",
  },
  {
    id: "2611.34051",
    title: "Stable Gated DeltaNet-2: Understanding and Mitigating Recurrent State Instability",
    date: "2026-11-25",
  },
  {
    id: "2611.31201",
    title: "Embo-Harness: Towards Understanding Frontier-Model-as-Policy Harness",
    date: "2026-11-23",
  },
  {
    id: "2611.34232",
    title: "OS-Omni: Benchmarking Generalist Computer-Using Agents on Long-Horizon Workflows Across Platforms",
    date: "2026-11-25",
  },
  {
    id: "2611.27193",
    title: "cmHC: Balancing Stream Mixing in Hyper-Connections via Geometric Contraction",
    date: "2026-11-20",
  },
  {
    id: "2611.30634",
    title: "Rewirable Circuits in Transformers with Loom Attention",
    date: "2026-11-23",
  },
];

const publishedDate = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function ArxivPicks() {
  return (
    <section aria-labelledby="arxiv-picks-heading">
      <h2 id="arxiv-picks-heading" className="fd-row-title">arXiv picks</h2>
      <p className="fd-row-meta">
        Selected Nov 27, 2026 using{" "}
        <a href="https://huggingface.co/papers/week/2026-W48">Hugging Face Daily Papers</a>.
      </p>
      <ul className="fd-list">
        {papers.map(({ id, title, date }) => (
          <li key={id} className="fd-row">
            <h3 className="fd-row-title">
              <a href={`https://arxiv.org/abs/${id}`}>{title}</a>
            </h3>
            <div className="fd-row-meta">
              <time dateTime={date}>{publishedDate.format(new Date(date))}</time>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
