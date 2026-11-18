/**
 * A review report, rendered as the safe Markdown subset in `markdown.ts`.
 *
 * ```tsx
 * <ReportMarkdown source={review.report} className="pr-report__body" />
 * ```
 *
 * The form tells a reviewer "Markdown is allowed"; this is what keeps that
 * promise wherever a report is read. Every element comes from the parsed tree,
 * never from a string handed to the DOM, so a report cannot bring markup,
 * script or a scriptable link with it. Links open in a new tab with
 * `rel="nofollow noopener"`: a report is user content, and a reviewer's link
 * earns the target no search credit and no handle on this page.
 *
 * Server-safe: no state, no effects.
 */

import type { ReactNode } from "react";

import { parseMarkdown, type MdBlock, type MdInline } from "./markdown";

/** The `rel` every link in a report carries. */
export const REPORT_LINK_REL = "nofollow noopener";

function inline(nodes: readonly MdInline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return <br key={index} />;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "em":
        return <em key={index}>{inline(node.children)}</em>;
      case "strong":
        return <strong key={index}>{inline(node.children)}</strong>;
      case "link":
        return (
          <a key={index} href={node.href} rel={REPORT_LINK_REL} target="_blank">
            {inline(node.children)}
          </a>
        );
    }
  });
}

function block(node: MdBlock, index: number): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={index}>{inline(node.children)}</p>;
    case "heading": {
      // Two levels deeper than the Markdown: `##` is `h4`, so a report's
      // headings sit below the page's own `h1` and its `h2`/`h3` sections;
      // `####` stops at `h6`.
      switch (node.level) {
        case 2:
          return <h4 key={index}>{inline(node.children)}</h4>;
        case 3:
          return <h5 key={index}>{inline(node.children)}</h5>;
        case 4:
          return <h6 key={index}>{inline(node.children)}</h6>;
      }
    }
    case "code":
      return (
        <pre key={index}>
          <code>{node.text}</code>
        </pre>
      );
    case "list": {
      const items = node.items.map((item, position) => (
        <li key={position}>{inline(item)}</li>
      ));
      return node.ordered ? (
        <ol key={index} start={node.start !== 1 ? node.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={index}>{items}</ul>
      );
    }
  }
}

export interface ReportMarkdownProps {
  /** The report as the reviewer wrote it. */
  source: string;
  /** Class for the wrapping element, so a host can style the report. */
  className?: string;
}

export function ReportMarkdown({ source, className }: ReportMarkdownProps) {
  return <div className={className}>{parseMarkdown(source).map(block)}</div>;
}
