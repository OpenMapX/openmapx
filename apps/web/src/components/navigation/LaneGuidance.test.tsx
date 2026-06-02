import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LaneGuidance } from "./LaneGuidance";

describe("LaneGuidance", () => {
  it("renders nothing when there are no lanes", () => {
    expect(renderToStaticMarkup(<LaneGuidance lanes={undefined} />)).toBe("");
  });
  it("renders one element per lane and emphasizes valid lanes", () => {
    const html = renderToStaticMarkup(
      <LaneGuidance
        lanes={[
          { indications: ["left"], valid: false },
          { indications: ["straight"], valid: true },
        ]}
      />,
    );
    expect(html).toContain('data-valid="true"');
    expect(html).toContain('data-valid="false"');
  });
});
