// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getMapObstructionInsets } from "@/lib/mapObstructions";
import { PhoneWaypointCard, WAYPOINT_CARD_BOTTOM_VAR } from "./PhoneWaypointCard";

describe("PhoneWaypointCard", () => {
  it("floats the stops over the map and tells the sheet and camera where it ends", () => {
    const { unmount } = render(
      <div data-testid="sheet">
        <PhoneWaypointCard>
          <input aria-label="origin" />
        </PhoneWaypointCard>
      </div>,
    );

    // Portalled out of the sheet that renders it.
    expect(screen.getByTestId("sheet").contains(screen.getByLabelText("origin"))).toBe(false);
    const root = document.documentElement;
    expect(root.style.getPropertyValue(WAYPOINT_CARD_BOTTOM_VAR)).toMatch(/px$/);
    expect(getMapObstructionInsets().top).toBeGreaterThanOrEqual(0);

    unmount();
    expect(root.style.getPropertyValue(WAYPOINT_CARD_BOTTOM_VAR)).toBe("");
  });
});
