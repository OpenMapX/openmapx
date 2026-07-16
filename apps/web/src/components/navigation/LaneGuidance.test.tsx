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

  it("renders a blank cell for a 'none' lane", () => {
    const html = renderToStaticMarkup(
      <LaneGuidance lanes={[{ indications: ["none"], valid: false }]} />,
    );
    expect(html).toContain('data-empty="true"');
  });

  it("overlays an arrow per indication in a multi-indication lane", () => {
    const html = renderToStaticMarkup(
      <LaneGuidance lanes={[{ indications: ["straight", "right"], valid: true }]} />,
    );
    expect(html).toContain('data-arrow-count="2"');
  });

  it("marks the active indication's arrow", () => {
    const html = renderToStaticMarkup(
      <LaneGuidance
        lanes={[{ indications: ["straight", "right"], valid: true, active: "right" }]}
      />,
    );
    expect(html).toContain('data-active="true"');
  });

  it("highlights through lanes for a keep-left instruction", () => {
    const html = renderToStaticMarkup(
      <LaneGuidance
        maneuver={{ type: "keep", modifier: "left" }}
        lanes={[
          { indications: ["through"], valid: false },
          { indications: ["through"], valid: false },
          { indications: ["slight_right"], valid: false },
        ]}
      />,
    );
    expect(html.match(/data-valid="true"/g)?.length).toBe(2);
    expect(html.match(/data-valid="false"/g)?.length).toBe(1);
  });
});
