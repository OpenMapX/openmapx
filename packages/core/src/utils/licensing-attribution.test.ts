import { describe, expect, it } from "vitest";
import { buildRuntimeAttributionHtml } from "./attribution";

describe("scoped licence attribution presentation", () => {
  it("renders all content choices and preserves captured notices without software-as-data credit", () => {
    const licensing = {
      version: 1 as const,
      bindings: [
        {
          scope: "software" as const,
          subject: "Engine",
          license: { kind: "spdx" as const, expression: "MIT" },
        },
        {
          scope: "data" as const,
          subject: "Weather",
          license: { kind: "spdx" as const, expression: "CC-BY-4.0 OR NLOD-2.0" },
          notice: "Original <publisher>",
          conditions: ["Preserve observation date"],
        },
      ],
    };
    const html = buildRuntimeAttributionHtml({ sourceId: "weather", name: "Weather", licensing });
    expect(html).toContain("CC-BY-4.0 OR NLOD-2.0");
    expect(html).toContain("creativecommons.org");
    expect(html).toContain("data.norge.no");
    expect(html).toContain("Original &lt;publisher&gt;");
    expect(html).toContain("Preserve observation date");
    expect(html).not.toContain("MIT");
  });
});

it("retains every atom link even when a compound grant includes its publisher's declaration URL", () => {
  const html = buildRuntimeAttributionHtml({
    sourceId: "weather",
    name: "Weather",
    licensing: {
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Weather",
          license: {
            kind: "spdx",
            expression: "CC-BY-4.0 OR NLOD-2.0",
            url: "https://example.test/licences",
          },
        },
      ],
    },
  });
  expect(html).toContain("https://example.test/licences");
  expect(html).toContain("creativecommons.org");
  expect(html).toContain("data.norge.no");
});
