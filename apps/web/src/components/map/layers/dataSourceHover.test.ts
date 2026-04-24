import { describe, expect, it } from "vitest";
import { pickHoveredDataSourceItemId } from "./dataSourceHover";

describe("pickHoveredDataSourceItemId", () => {
  it("prefers marker-layer ids when both marker and label hits are present", () => {
    expect(
      pickHoveredDataSourceItemId(
        [
          { layer: { id: "ds-bike-labels" }, properties: { id: "label-id" } },
          { layer: { id: "ds-bike-markers" }, properties: { id: "marker-id" } },
        ],
        "ds-bike-markers",
      ),
    ).toBe("marker-id");
  });

  it("falls back to label-layer ids when no marker feature is hit", () => {
    expect(
      pickHoveredDataSourceItemId(
        [{ layer: { id: "ds-bike-labels" }, properties: { id: "label-only-id" } }],
        "ds-bike-markers",
      ),
    ).toBe("label-only-id");
  });

  it("clears hover when the hit features do not expose an item id", () => {
    expect(
      pickHoveredDataSourceItemId(
        [
          { layer: { id: "ds-bike-labels" }, properties: {} },
          { layer: { id: "ds-bike-markers" }, properties: { id: "" } },
        ],
        "ds-bike-markers",
      ),
    ).toBeNull();
  });
});
