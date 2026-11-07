import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LaneGuidance } from "./LaneGuidance";

describe("LaneGuidance", () => {
  it.each(["banner", "standalone"] as const)(
    "paints preferred and usable lanes equally in %s",
    (variant) => {
      const { container } = render(
        <LaneGuidance
          variant={variant}
          lanes={[
            { indications: ["left"], valid: true, preferred: true },
            { indications: ["left"], valid: true, preferred: false },
            { indications: ["left"], valid: false },
          ]}
        />,
      );
      const cells = [...container.querySelectorAll("[data-valid]")];
      expect(cells).toHaveLength(3);
      const backgrounds = cells.map((cell) => getComputedStyle(cell).backgroundColor);
      expect(backgrounds[0]).toBe(backgrounds[1]);
      expect(["transparent", "rgba(0, 0, 0, 0)"]).not.toContain(backgrounds[0]);
      expect(["transparent", "rgba(0, 0, 0, 0)"]).toContain(backgrounds[2]);
      const arrows = [...container.querySelectorAll("svg")];
      expect(arrows).toHaveLength(3);
      const opacities = arrows.map((arrow) => Number(getComputedStyle(arrow).opacity));
      expect(opacities.slice(0, 2)).toEqual([1, 1]);
      expect(opacities[2]).toBeLessThan(1);
    },
  );
  it("renders nothing when there are no lanes", () => {
    expect(renderToStaticMarkup(<LaneGuidance lanes={undefined} />)).toBe("");
  });

  it("paints only the lanes whose destinations match the sign at an all-through split", () => {
    const through = { indications: ["through"], valid: undefined };
    const lanes = [through, through, through, through];
    const keepLeft = { type: "keep", modifier: "left" };
    const { container, rerender } = render(<LaneGuidance lanes={lanes} maneuver={keepLeft} />);
    const painted = () =>
      [...container.querySelectorAll("[data-valid]")].map(
        (cell) =>
          !["transparent", "rgba(0, 0, 0, 0)"].includes(getComputedStyle(cell).backgroundColor),
      );
    expect(painted()).toEqual([false, false, false, false]);
    rerender(
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
    expect(painted()).toEqual([true, true, false, false]);
  });

  it("draws a blank bar rather than an arrow for a none lane", () => {
    const { container } = render(
      <LaneGuidance lanes={[{ indications: ["none"], valid: false }]} />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("[data-empty]")).toHaveStyle({ width: "12px", height: "2px" });
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

  it("overlays both indications and paints the selected arrow brightest", () => {
    const { container } = render(
      <LaneGuidance
        lanes={[{ indications: ["straight", "right"], valid: true, active: "right" }]}
      />,
    );
    const arrows = [...container.querySelectorAll("svg")];
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) expect(arrow).toHaveStyle({ position: "absolute" });
    const [inactive, active] = arrows.map((arrow) => Number(getComputedStyle(arrow).opacity));
    expect(active).toBe(1);
    expect(inactive).toBeGreaterThan(0);
    expect(inactive).toBeLessThan(1);
  });
});
