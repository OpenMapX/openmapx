import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpeedLimitBadge } from "./SpeedLimitBadge";

describe("SpeedLimitBadge", () => {
  it("renders nothing when speed limit is null", () => {
    expect(renderToStaticMarkup(<SpeedLimitBadge speedLimit={null} units="metric" />)).toBe("");
  });
  it("renders the limit", () => {
    const html = renderToStaticMarkup(<SpeedLimitBadge speedLimit={50} units="metric" />);
    expect(html).toContain("50");
  });
});
