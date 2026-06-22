import type { IntegrationContext } from "@openmapx/extension-sdk";
import { freshnessNow, PLATFORM_VERSION } from "@openmapx/extension-sdk";
import { createMockIntegrationContext } from "@openmapx/extension-sdk/testing";
import { describe, expect, it } from "vitest";

describe("extension-sdk public surface", () => {
  it("exposes the context type, a runtime helper, and the mock", () => {
    const ctx: IntegrationContext = createMockIntegrationContext();
    expect(ctx.id).toBeDefined();
    expect(typeof freshnessNow).toBe("function");
    expect(PLATFORM_VERSION).toMatch(/^\d+\.\d+/);
  });
});
