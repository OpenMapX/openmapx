import { describe, expect, it } from "vitest";
import { defineTransitProvider } from "../transit-provider-factory";

describe("defineTransitProvider wrapRT", () => {
  it("carries the upstream realtime age into the result's freshness", () => {
    const { wrapRT } = defineTransitProvider();
    const result = wrapRT([], undefined, { dataAsOf: "2026-10-31T11:59:30.000Z" });
    expect(result.freshness).toMatchObject({
      hasRealtimeData: true,
      dataAsOf: "2026-10-31T11:59:30.000Z",
    });
  });

  it("leaves the age unknown when the source states none", () => {
    const { wrapRT } = defineTransitProvider();
    expect(wrapRT([]).freshness).not.toHaveProperty("dataAsOf");
    expect(wrapRT([], undefined, {}).freshness).not.toHaveProperty("dataAsOf");
  });
});
