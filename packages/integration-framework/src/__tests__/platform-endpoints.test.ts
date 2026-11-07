import { describe, expect, it, vi } from "vitest";
import { resolveIntegrationPlatformEndpoint } from "../platform-endpoints";

describe("integration platform endpoint bridge", () => {
  it("resolves integration keys and enabled required services", () => {
    const integration = {
      manifest: { endpointConfigKeys: { motis: "customEndpoint" } },
      config: { customEndpoint: "http://config.example" },
    };
    const env = { MOTIS_URL: "http://env.example:9000" };
    const required = vi.fn(() => ({ url: "http://motis.registry:8080", enabled: true }));
    expect(resolveIntegrationPlatformEndpoint(integration, required, "motis", env)).toEqual({
      url: "http://motis.registry:8080",
      source: "service",
    });
    expect(required).toHaveBeenCalledWith("motis");
    expect(
      resolveIntegrationPlatformEndpoint(
        integration,
        () => ({ url: "http://disabled", enabled: false }),
        "motis",
        env,
      ),
    ).toEqual({
      url: "http://config.example",
      source: "setting",
    });
    const bare = { ...integration, config: {} };
    expect(resolveIntegrationPlatformEndpoint(bare, () => null, "motis", env)).toEqual({
      url: "http://env.example:9000",
      source: "operator",
    });
    expect(resolveIntegrationPlatformEndpoint(bare, () => null, "motis", {})).toBeNull();
  });
});
