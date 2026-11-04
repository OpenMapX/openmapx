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

  it("lights the lanes the OSM destinations send toward the sign at an all-through split", () => {
    const through = { indications: ["through"], valid: false };
    const lanes = [through, through, through, through];
    const keepLeft = { type: "keep", modifier: "left" };
    const unlit = renderToStaticMarkup(<LaneGuidance lanes={lanes} maneuver={keepLeft} />);
    expect(unlit).not.toContain('data-valid="true"');
    const lit = renderToStaticMarkup(
      <LaneGuidance
        lanes={lanes}
        maneuver={keepLeft}
        sign={{ exitBranches: ["A 44"], exitToward: ["Düsseldorf"] }}
        laneDestinations={[
          { destinations: ["Düsseldorf"], refs: ["A 44"] },
          { destinations: ["Düsseldorf"], refs: ["A 44"] },
          { destinations: ["Liège"], refs: ["A 44"] },
          { destinations: ["Liège"], refs: ["A 44"] },
        ]}
      />,
    );
    expect(lit.match(/data-valid="true"/g)).toHaveLength(2);
  });

  it("renders a blank cell for a 'none' lane", () => {
    const html = renderToStaticMarkup(
      <LaneGuidance lanes={[{ indications: ["none"], valid: false }]} />,
    );
    expect(html).toContain('data-empty="true"');
  });

  it("draws the maneuver's arrow in unmarked lanes the engine chose", () => {
    // A 42 before Kreuz Kamp-Lintfort: turn:lanes=none|none|slight_right|slight_right,
    // OSRM marks the two unmarked lanes as the way onto the left branch.
    const html = renderToStaticMarkup(
      <LaneGuidance
        maneuver={{ type: "fork", modifier: "slight left" }}
        lanes={[
          { indications: ["none"], valid: true },
          { indications: ["none"], valid: true },
          { indications: ["slight right"], valid: false },
          { indications: ["slight right"], valid: false },
        ]}
      />,
    );
    expect(html.match(/data-inferred="true"/g)).toHaveLength(2);
    expect(html.match(/data-active="true"/g)).toHaveLength(2);
    expect(html).not.toContain('data-empty="true"');
  });

  it("keeps unmarked lanes blank when the engine did not choose them", () => {
    const maneuver = { type: "turn", modifier: "left" };
    const notChosen = renderToStaticMarkup(
      <LaneGuidance
        maneuver={maneuver}
        lanes={[
          { indications: ["left"], valid: true },
          { indications: ["none"], valid: false },
        ]}
      />,
    );
    expect(notChosen).toContain('data-empty="true"');
    // Without any engine choice the lanes are our own recommendation: no guessed arrow.
    const guessed = renderToStaticMarkup(
      <LaneGuidance
        maneuver={maneuver}
        lanes={[
          { indications: ["none"], valid: false },
          { indications: ["right"], valid: false },
        ]}
      />,
    );
    expect(guessed).toContain('data-valid="true"');
    expect(guessed).not.toContain('data-inferred="true"');
    expect(guessed).toContain('data-empty="true"');
  });

  it("keeps a chosen unmarked lane blank for a maneuver without a lane direction", () => {
    const html = renderToStaticMarkup(
      <LaneGuidance
        maneuver={{ type: "roundabout", modifier: "right" }}
        lanes={[{ indications: ["none"], valid: true }]}
      />,
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
