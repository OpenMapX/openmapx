import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { PARTNER_CREDENTIALS, setup } from "./index.js";

describe("ride-partner setup", () => {
  it("registers nothing when no credentials are stored", () => {
    const ctx = createMockIntegrationContext({ id: "ride-partner", config: {} });
    setup(ctx);
    expect(ctx.registered.ride).toEqual([]);
  });

  it("still registers nothing when credentials are stored, because no adapter exists yet", () => {
    const ctx = createMockIntegrationContext({
      id: "ride-partner",
      config: { "yango-api-key": "a-key" },
    });
    setup(ctx);
    expect(ctx.registered.ride).toEqual([]);
  });

  it("warns the operator when a credential is set but unusable", () => {
    const warn = vi.fn();
    const ctx = createMockIntegrationContext({
      id: "ride-partner",
      config: { "yango-api-key": "a-key" },
    });
    ctx.log.warn = warn;
    setup(ctx);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/yango/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no adapter/i));
  });

  it("stays quiet when a stored credential is blank", () => {
    const warn = vi.fn();
    const ctx = createMockIntegrationContext({
      id: "ride-partner",
      config: { "yango-api-key": "   " },
    });
    ctx.log.warn = warn;
    setup(ctx);
    expect(warn).not.toHaveBeenCalled();
  });

  it("declares every credential key in the <sourceId>-<field> form", () => {
    for (const cred of PARTNER_CREDENTIALS) {
      for (const key of cred.keys) {
        expect(key.startsWith(`${cred.sourceId}-`)).toBe(true);
      }
    }
  });
});
