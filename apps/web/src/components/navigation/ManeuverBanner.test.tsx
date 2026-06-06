import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "in") return `In ${String(values?.distance ?? "")}`;
    if (key === "then") return `Then ${String(values?.instruction ?? "")}`;
    return key;
  },
}));
vi.mock("@openmapx/core", () => ({
  formatDistance: (m: number) => `${m} m`,
  formatMeasurementDistance: (m: number, sys: string) =>
    sys === "imperial" ? `${m} ft` : `${m} m`,
}));

import { ManeuverBanner } from "./ManeuverBanner";

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
    expect(html).toContain("Then Turn left onto 2nd Ave");
  });
});
