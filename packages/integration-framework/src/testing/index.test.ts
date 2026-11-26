import { describe, expect, it } from "vitest";
import { createMockIntegrationContext } from "./index";

describe("createMockIntegrationContext", () => {
  it("resolves a declared required service in the mock context", () => {
    const ctx = createMockIntegrationContext({
      requiredServices: { "demo-engine": "http://demo:8080" },
    });
    expect(ctx.getRequiredService("demo-engine")).toEqual({
      serviceId: "demo-engine",
      url: "http://demo:8080",
      enabled: true,
    });
    expect(ctx.getRequiredService("other")).toBeNull();
  });

  it("resolves no required service when none is declared", () => {
    expect(createMockIntegrationContext().getRequiredService("demo-engine")).toBeNull();
  });
});
