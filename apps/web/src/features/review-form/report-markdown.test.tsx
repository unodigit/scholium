// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReportMarkdown } from "./report-markdown";

afterEach(cleanup);

/** Render `source` and hand back the element the report went into. */
function rendered(source: string): HTMLElement {
  const { container } = render(<ReportMarkdown source={source} className="body" />);
  return container.querySelector(".body") as HTMLElement;
}

describe("ReportMarkdown: the subset a report may use", () => {
  it("renders **strong** and *emphasis*, not the asterisks", () => {
    const body = rendered("**Summary:** the *method* is __sound__ and _simple_.");

    expect(body.querySelectorAll("strong")).toHaveLength(2);
    expect(body.querySelector("strong")?.textContent).toBe("Summary:");
    expect(body.querySelectorAll("em")).toHaveLength(2);
    expect(body.textContent).toBe("Summary: the method is sound and simple.");
    expect(body.textContent).not.toMatch(/[*_]/);
  });

  it("splits paragraphs on blank lines and keeps a single line break", () => {
    const body = rendered("First paragraph,\nsame paragraph.\n\nSecond paragraph.");

    const paragraphs = body.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].querySelector("br")).not.toBeNull();
    expect(paragraphs[0].textContent).toBe("First paragraph,same paragraph.");
    expect(paragraphs[1].textContent).toBe("Second paragraph.");
  });

  it("renders bulleted and numbered lists", () => {
    const body = rendered("Strengths:\n- clear\n- **fast**\n\nSteps:\n1. read\n2. run");

    const bullets = body.querySelectorAll("ul > li");
    expect(Array.from(bullets).map((li) => li.textContent)).toEqual(["clear", "fast"]);
    expect(body.querySelector("ul li strong")?.textContent).toBe("fast");
    const steps = body.querySelectorAll("ol > li");
    expect(Array.from(steps).map((li) => li.textContent)).toEqual(["read", "run"]);
    expect(body.textContent).not.toMatch(/^\s*[-*]\s/m);
  });

  it("lets a list follow a line of text without a blank line", () => {
    const body = rendered("Strengths:\n- clear\n- fast");

    expect(body.querySelector("p")?.textContent).toBe("Strengths:");
    expect(body.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders inline code and fenced code blocks as code, untouched by the other rules", () => {
    const body = rendered("Run `make **test**` first.\n\n```py\nx = *a* + _b_\n```");

    expect(body.querySelector("p code")?.textContent).toBe("make **test**");
    const block = body.querySelector("pre > code");
    expect(block?.textContent).toBe("x = *a* + _b_");
    expect(body.querySelectorAll("strong, em")).toHaveLength(0);
  });

  it("renders links that cannot reach back into the page", () => {
    const body = rendered("See [the appendix](https://example.org/a?b=1&c=2) and [mail](mailto:a@example.org).");

    const links = body.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("https://example.org/a?b=1&c=2");
    expect(links[0].textContent).toBe("the appendix");
    for (const link of Array.from(links)) {
      expect(link.getAttribute("rel")).toBe("nofollow noopener");
    }
  });

  it("does not leave ordinary prose looking like markup", () => {
    const body = rendered("snake_case_name costs 2 * 3 * 4 = 24, see item 2024. Done");

    expect(body.querySelectorAll("em, strong, ul, ol")).toHaveLength(0);
    expect(body.textContent).toBe("snake_case_name costs 2 * 3 * 4 = 24, see item 2024. Done");
  });

  it("renders nothing for an empty report", () => {
    expect(rendered("  \n \n").children).toHaveLength(0);
  });
});

describe("ReportMarkdown: no raw HTML, no script, no scriptable links", () => {
  it("shows HTML as text instead of parsing it", () => {
    const body = rendered(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<b>bold</b> **ok**',
    );

    expect(body.querySelector("script, img, b")).toBeNull();
    expect(body.textContent).toContain("<script>alert(1)</script>");
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(body.textContent).toContain("<b>bold</b>");
    expect(body.querySelector("strong")?.textContent).toBe("ok");
  });

  it("does not make a link of a script, data or relative address", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html;base64,AAAA",
      "vbscript:x",
      "//evil.example/x",
      "/relative",
    ]) {
      const body = rendered(`[click](${href})`);
      expect(body.querySelector("a"), href).toBeNull();
      expect(body.textContent, href).toContain("click");
    }
  });

  it("keeps markup out of link text and attributes", () => {
    const body = rendered("[<img src=x onerror=alert(1)>](https://example.org/x)");

    const link = body.querySelector("a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(body.querySelector("img")).toBeNull();
    expect(link.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(link.getAttributeNames().sort()).toEqual(["href", "rel", "target"]);

    // A quote in the address cannot close the attribute and add its own.
    const quoted = rendered('[x](https://example.org/"onmouseover="alert(1))');
    expect(quoted.querySelector("a")).toBeNull();
  });

  it("never emits an element outside the subset", () => {
    const body = rendered(
      "# Heading\n\n> quote\n\n| a | b |\n\n![img](https://example.org/x.png)\n\n---\n\n**b** *i* `c` [l](https://e.org)\n\n- x\n\n1. y",
    );

    const allowed = new Set(["DIV", "P", "STRONG", "EM", "CODE", "PRE", "UL", "OL", "LI", "A", "BR"]);
    for (const element of Array.from(body.querySelectorAll("*"))) {
      expect(allowed.has(element.tagName), element.tagName).toBe(true);
    }
  });
});
