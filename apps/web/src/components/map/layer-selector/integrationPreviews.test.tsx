import { describe, expect, it } from "vitest";
import { INTEGRATION_PREVIEWS } from "./integrationPreviews";
import { trafficPreview } from "./layerPreviewSvgs";

describe("INTEGRATION_PREVIEWS", () => {
  it("uses the colored-road preview for the traffic-flow overlay", () => {
    expect(INTEGRATION_PREVIEWS["traffic-flow"]).toBe(trafficPreview);
  });
});
