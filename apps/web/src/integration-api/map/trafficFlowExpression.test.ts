import { describe, expect, it } from "vitest";
import { flowColorExpression } from "./trafficFlowExpression";

describe("flowColorExpression", () => {
  it("reads the property names it is given", () => {
    const expr = JSON.stringify(flowColorExpression("speedRatio", "los"));
    expect(expr).toContain('["get","speedRatio"]');
    expect(expr).toContain('["get","los"]');
    expect(expr).not.toContain("speed_ratio");
  });

  it("carries every ramp stop", () => {
    const expr = JSON.stringify(flowColorExpression("speed_ratio", "los"));
    for (const hex of ["#7e0023", "#e8112d", "#ff8c00", "#ffd500", "#2ecc40"]) {
      expect(expr).toContain(hex);
    }
  });
});
