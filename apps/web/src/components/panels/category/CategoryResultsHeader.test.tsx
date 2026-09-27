// @vitest-environment jsdom

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CategoryResultsHeader } from "./CategoryResultsHeader";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const feeds: Attribution[] = ["alpha", "bravo", "charlie", "delta"].map((sourceId) => ({
  sourceId,
  name: sourceId,
}));

function renderHeader(isTransit: boolean) {
  return render(
    <CategoryResultsHeader
      count={4}
      isTransit={isTransit}
      sort="relevance"
      onSort={vi.fn()}
      distanceReference={null}
      showTravelTime={false}
      showMapUpdate={false}
      autoRefresh={false}
      onAutoRefresh={vi.fn()}
      attributions={feeds}
    />,
  );
}

describe("CategoryResultsHeader attribution visibility", () => {
  it("shows every transit feed while keeping the POI three-source expansion", () => {
    const transit = renderHeader(true);
    expect(transit.container.querySelectorAll("[data-source-id]")).toHaveLength(4);
    expect(transit.container.querySelector("button")).toBeNull();

    transit.unmount();
    const poi = renderHeader(false);
    expect(poi.container.querySelectorAll("[data-source-id]")).toHaveLength(3);
    expect(poi.container.querySelector('[data-source-id="delta"]')).toBeNull();
    expect(poi.getByRole("button", { name: "common.showMore" })).toBeInTheDocument();
  });
});
