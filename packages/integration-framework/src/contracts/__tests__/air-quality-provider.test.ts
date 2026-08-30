import { describe, expect, it } from "vitest";

import { createMockIntegrationContext } from "../../testing";
import { type AirQualityProvider, assertAirQualityProviderContract } from "../air-quality-provider";

function provider(update: Partial<AirQualityProvider> = {}): AirQualityProvider {
  return {
    id: "official-aq",
    sourceIds: ["official-source"],
    priority: 10,
    timeoutMs: 3_000,
    capabilities: new Set(["current", "pollutants"]),
    coverage: { countries: ["US"] },
    getCurrent: async (_query, call) => {
      call.signal.throwIfAborted();
      return [];
    },
    ...update,
  };
}

describe("AirQualityProvider contract", () => {
  it("accepts a capability-matched provider and the shared harness captures it", () => {
    const value = provider();
    expect(() =>
      assertAirQualityProviderContract(value, new Set(["official-source"])),
    ).not.toThrow();
    const ctx = createMockIntegrationContext();
    ctx.registerAirQualityProvider(value);
    expect(ctx.registered.airQuality).toEqual([value]);
  });

  it.each([249, 4_501, 250.5])(
    "rejects timeoutMs %s outside the bounded integer range",
    (timeoutMs) => {
      expect(() => assertAirQualityProviderContract(provider({ timeoutMs }))).toThrow(
        /250 to 4500/,
      );
    },
  );

  it("rejects source IDs absent from the owning manifest", () => {
    expect(() =>
      assertAirQualityProviderContract(provider(), new Set(["different-source"])),
    ).toThrow(/manifest\.dataSources/);
  });

  it("rejects capabilities without methods and methods without capabilities", () => {
    expect(() => assertAirQualityProviderContract(provider({ getCurrent: undefined }))).toThrow(
      /capability current/,
    );
    expect(() =>
      assertAirQualityProviderContract(provider({ capabilities: new Set(["pollutants"]) })),
    ).toThrow(/capability current/);
    expect(() =>
      assertAirQualityProviderContract(
        provider({ capabilities: new Set(), getCurrent: undefined }),
      ),
    ).toThrow(/operational capability/);
  });

  it("requires both raster methods and valid explicit coverage", () => {
    expect(() =>
      assertAirQualityProviderContract(
        provider({
          capabilities: new Set(["raster"]),
          getCurrent: undefined,
          getRasterTimes: async () => ({ frames: [] }),
        }),
      ),
    ).toThrow(/capability raster/);
    expect(() =>
      assertAirQualityProviderContract(provider({ coverage: { countries: ["us"] } })),
    ).toThrow(/uppercase ISO/);
    expect(() =>
      assertAirQualityProviderContract(provider({ coverage: { bbox: [10, 20, 5, 30] } })),
    ).toThrow(/bbox/);
  });
});
