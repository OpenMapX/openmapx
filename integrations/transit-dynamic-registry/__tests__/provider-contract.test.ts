import {
  assertRealtimeProviderContract,
  assertTransitProviderContract,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RegistryEntry } from "../registry-types";

// The catalog fetch is mocked so this runs offline and deterministically. The
// repo-wide conformance test deliberately registers nothing for this
// integration (it disables network), so this is where the dynamically-built
// providers are actually contract-checked — one fixture per supported adapter.
vi.mock("../fetcher", () => ({
  fetchRegistryEntries: vi.fn(),
  setCache: vi.fn(),
  setGithubToken: vi.fn(),
}));

import { fetchRegistryEntries } from "../fetcher";
import { setup } from "../index";
import { registry } from "../registry";

const HAFAS_ENTRY: RegistryEntry = {
  id: "de/vbb-hafas-mgate",
  slug: "vbb",
  prefix: "vbb:",
  name: "VBB",
  protocol: "hafasMgate",
  supportedLanguages: ["de"],
  timezone: "Europe/Berlin",
  options: {},
  coverage: { bbox: [11.26, 51.36, 14.77, 53.56], tiers: [] },
  attribution: { name: "VBB" },
};

const OTP_ENTRY: RegistryEntry = {
  id: "us/example-otp",
  slug: "exotp",
  prefix: "exotp:",
  name: "Example OTP",
  protocol: "otpGraphQl",
  supportedLanguages: ["en"],
  timezone: "America/New_York",
  options: { endpoint: "https://otp.example/otp/routers/default/index/graphql" },
  coverage: { bbox: [-74.3, 40.5, -73.7, 40.9], tiers: [] },
  attribution: { name: "Example OTP" },
};

describe("transit-dynamic-registry provider contract", () => {
  let ctx: ReturnType<typeof createMockIntegrationContext>;

  beforeAll(async () => {
    vi.mocked(fetchRegistryEntries).mockResolvedValue([HAFAS_ENTRY, OTP_ENTRY]);
    ctx = createMockIntegrationContext({ id: "transit-dynamic-registry" });
    await setup(ctx);
  });

  afterAll(() => {
    registry.stopRefresh();
    vi.restoreAllMocks();
  });

  it("registers one transit provider per supported registry entry", () => {
    expect(ctx.registered.transit.length).toBe(2);
  });

  it("every dynamically-built provider satisfies its capability contract", () => {
    for (const provider of ctx.registered.transit) {
      expect(() =>
        assertTransitProviderContract(
          provider as unknown as Parameters<typeof assertTransitProviderContract>[0],
        ),
      ).not.toThrow();
    }
    for (const provider of ctx.registered.realtime) {
      expect(() =>
        assertRealtimeProviderContract(
          provider as unknown as Parameters<typeof assertRealtimeProviderContract>[0],
        ),
      ).not.toThrow();
    }
  });
});
