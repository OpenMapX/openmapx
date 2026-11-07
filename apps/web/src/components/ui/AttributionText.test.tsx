import { sanitizeAttributionHtml } from "@openmapx/core";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { AttributionText } from "./AttributionText";

it("reconstructed contributor HTML produces only safe DOM tags and attributes", () => {
  const html = sanitizeAttributionHtml(
    '<svg onload="bad()"><a href="java&#x73;cript:bad()">unsafe</a></svg><a href="https://actual.test/?name=&quot; onmouseover=&quot;bad()" onclick="bad()"><code>&lt;img src=x onerror=bad()&gt;</code></a>',
  );
  const { container } = render(<AttributionText html={html} />);
  const element = container.querySelector("span");
  if (!element) throw new Error("Attribution insertion missing");
  expect(element.querySelector("script, svg, img, [onclick], [onload], [onmouseover]")).toBeNull();
  expect(element.querySelector("a")?.getAttribute("href")).toBe(
    'https://actual.test/?name=" onmouseover="bad()',
  );
  expect(element.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(element.textContent).toBe("unsafe<img src=x onerror=bad()>");
});
