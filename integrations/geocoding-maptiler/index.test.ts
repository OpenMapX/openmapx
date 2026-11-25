import type { IntegrationContext } from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

const admitSharedRequest = vi.fn(async () => ({ allowed: true as const }));
const requestedKeys: string[] = [];

/** The geocoder `setup` registers for this configuration, with a shared admission store. */
function geocoder(config: Record<string, unknown>) {
  const http = fakeHttpClient(({ options }) => {
    requestedKeys.push(String(options?.params?.key));
    return { features: [] };
  });
  const ctx = {
    ...createMockIntegrationContext({ config, http }),
    upstreamRuntime: { admitSharedRequest } as unknown as IntegrationContext["upstreamRuntime"],
  };
  const registered = ctx.registered.geocoding;
  setup(ctx);
  const provider = registered[0];
  if (!provider) throw new Error("setup registered no geocoding provider");
  return provider;
}

beforeEach(() => {
  vi.stubEnv("MAPTILER_API_KEY", "shared-key");
  vi.stubEnv("MAPTILER_DAILY_REQUEST_LIMIT", "100");
  admitSharedRequest.mockClear();
  requestedKeys.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("MapTiler geocoding setup", () => {
  it("spends the deployment's MapTiler budget when it searches with MAPTILER_API_KEY", async () => {
    await geocoder({}).geocode("Aachen");

    expect(requestedKeys).toEqual(["shared-key"]);
    expect(admitSharedRequest).toHaveBeenCalledOnce();
    expect(admitSharedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "provider-daily-budget", key: "maptiler" }),
    );
  });

  it("spends no shared budget with the integration's own key", async () => {
    await geocoder({ apiKey: "own-key" }).geocode("Aachen");

    expect(requestedKeys).toEqual(["own-key"]);
    expect(admitSharedRequest).not.toHaveBeenCalled();
  });

  it("treats an own key equal to MAPTILER_API_KEY as the shared key", async () => {
    await geocoder({ apiKey: "shared-key" }).geocode("Aachen");

    expect(admitSharedRequest).toHaveBeenCalledOnce();
  });
});
