import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "in") return `In ${String(values?.distance ?? "")}`;
    if (key === "then") return `Then ${String(values?.instruction ?? "")}`;
    if (key === "thenLabel") return "Then";
    if (key === "exitNumber") return `Exit ${String(values?.number ?? "")}`;
    if (key === "toward") return `toward ${String(values?.places ?? "")}`;
    return key;
  },
}));
vi.mock("@openmapx/core", () => ({
  formatDistance: (m: number) => `${m} m`,
  formatMeasurementDistance: (m: number, sys: string) =>
    sys === "imperial" ? `${m} ft` : `${m} m`,
  // Passthrough: the lanes already carry valid/active flags in these tests.
  resolveRecommendedLanes: (lanes?: unknown[]) => lanes ?? [],
  visibleToward: (list: string[], max = 3) => list.slice(0, max),
  signHeadline: (sign?: { exitToward?: string[]; exitNames?: string[] }) =>
    sign?.exitToward?.length ? sign.exitToward : (sign?.exitNames ?? []),
  refKind: () => "motorway",
}));

import { lowercaseFirstWord, ManeuverBanner } from "./ManeuverBanner";

describe("lowercaseFirstWord", () => {
  it("lowercases the leading verb so it reads mid-sentence after 'Then'", () => {
    expect(lowercaseFirstWord("Take exit 21.")).toBe("take exit 21.");
    expect(lowercaseFirstWord("Keep left to stay on A 57")).toBe("keep left to stay on A 57");
    expect(lowercaseFirstWord("Über die Brücke")).toBe("über die Brücke");
  });

  it("leaves refs/acronyms (no lowercase second letter) untouched", () => {
    expect(lowercaseFirstWord("B 477 toward …")).toBe("B 477 toward …");
    expect(lowercaseFirstWord("")).toBe("");
  });
});

describe("ManeuverBanner", () => {
  it("renders the instruction and distance to the maneuver", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        units="metric"
      />,
    );
    expect(html).toContain("Turn right onto Main St");
    expect(html).toContain("300 m");
  });

  it("omits the next-step preview when no next step is given", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        units="metric"
      />,
    );
    expect(html).not.toContain("Then ");
  });

  it("renders a next-step preview when a next step is given", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        nextInstruction="Turn left onto 2nd Ave"
        nextManeuver={{ type: "turn", modifier: "left" }}
        units="metric"
      />,
    );
    expect(html).toContain("Then turn left onto 2nd Ave");
  });

  it("puts lanes in the sub-row and the next maneuver in a compact badge", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Turn right onto Main St"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        nextInstruction="Turn left onto 2nd Ave"
        nextManeuver={{ type: "turn", modifier: "left" }}
        lanes={[
          { indications: ["through"], valid: false },
          { indications: ["right"], valid: true, active: "right" },
        ]}
        units="metric"
      />,
    );
    // Lanes take the sub-row…
    expect(html).toContain('data-valid="true"');
    // …the follow-up shows as the compact "Then" badge (label only, no full line)…
    expect(html).toContain("Then");
    // …so the full next-step instruction text is not spelled out.
    expect(html).not.toContain("2nd Ave");
  });

  it("renders the sign strip between the headline and the instruction", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Take exit 20 toward Neuss-Zentrum"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        sign={{
          exitNumbers: ["20"],
          exitBranches: ["A 46"],
          exitToward: ["Neuss-Zentrum"],
        }}
        country="DE"
        units="metric"
      />,
    );
    const headlineAt = html.indexOf("In 300 m");
    const stripAt = html.indexOf('data-testid="exit-sign-strip"');
    const instructionAt = html.indexOf("Take exit 20");
    expect(stripAt).toBeGreaterThan(headlineAt);
    expect(instructionAt).toBeGreaterThan(stripAt);
    expect(html).toContain("Exit 20");
    expect(html).toContain("Neuss-Zentrum");
  });

  it("keeps the lane sub-row when both sign and lanes are present", () => {
    const html = renderToStaticMarkup(
      <ManeuverBanner
        instruction="Take exit 20"
        distanceToManeuver={300}
        maneuver={{ type: "turn", modifier: "right" }}
        sign={{ exitNumbers: ["20"] }}
        lanes={[
          { indications: ["through"], valid: false },
          { indications: ["right"], valid: true, active: "right" },
        ]}
        units="metric"
      />,
    );
    expect(html).toContain('data-testid="exit-sign-strip"');
    expect(html).toContain('data-valid="true"');
  });
});
