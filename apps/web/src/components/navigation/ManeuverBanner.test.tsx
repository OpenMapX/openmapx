import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "in" ? `In ${String(values?.distance ?? "")}` : key,
}));
vi.mock("@openmapx/core", () => ({ formatDistance: (m: number) => `${m} m` }));

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
});
