import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fetcher at the integration path (registry code was moved to the integration)
vi.mock("@integrations/transit-dynamic-registry/fetcher", () => ({
  fetchRegistryEntries: vi.fn(),
}));

// Import after mocks
import { fetchRegistryEntries } from "@integrations/transit-dynamic-registry/fetcher";
import { registry } from "@integrations/transit-dynamic-registry/registry";
import type {
  ProtocolType,
  RegistryEntry,
} from "@integrations/transit-dynamic-registry/registry-types";

// Helpers

/** Build a minimal RegistryEntry for tests */
function makeEntry(
  id: string,
  prefix: string,
  protocol: string = "hafasMgate",
  bboxOverride?: [number, number, number, number],
): RegistryEntry {
  return {
    id,
    slug: id.split("/")[1]?.split("-")[0] ?? id,
    prefix,
    name: id,
    protocol: protocol as ProtocolType,
    supportedLanguages: [],
    options: {},
    coverage: {
      bbox: bboxOverride ?? [10, 45, 20, 55],
      tiers: [],
    },
  };
}

// Tests

describe("RegistryManager (registry singleton)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // NOTE: The registry singleton's state is fully replaced on every initialize() call
    // because index() assigns `this.entries = deduped` (a fresh array) and clears
    // `this.byPrefix` with .clear(). There is no risk of state bleeding between tests
    // even though they share the same singleton instance.
  });

  it("after initialize with 1 valid entry → entryCount ≥ 1, findByPrefix returns entry", async () => {
    const oebbEntry = makeEntry("at/oebb-hafas-mgate", "oebb:");
    vi.mocked(fetchRegistryEntries).mockResolvedValue([oebbEntry]);

    await registry.initialize();

    expect(registry.entryCount).toBeGreaterThanOrEqual(1);
    const found = registry.findByPrefix("oebb:");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("at/oebb-hafas-mgate");
    expect(found?.protocol).toBe("hafasMgate");
  });

  it("suppressed entries (de/db-hafas-mgate with prefix db:) → filtered out, findByPrefix returns null", async () => {
    const dbEntry = makeEntry("de/db-hafas-mgate", "db:");
    vi.mocked(fetchRegistryEntries).mockResolvedValue([dbEntry]);

    await registry.initialize();

    expect(registry.findByPrefix("db:")).toBeNull();
    expect(registry.entryCount).toBe(0);
  });

  it("unsupported protocol (otpRest) → filtered out, entryCount = 0", async () => {
    const otpRestEntry = makeEntry("us/some-otp-rest", "some:", "otpRest");
    vi.mocked(fetchRegistryEntries).mockResolvedValue([otpRestEntry]);

    await registry.initialize();

    expect(registry.entryCount).toBe(0);
    expect(registry.findByPrefix("some:")).toBeNull();
  });

  it("prefix collision → keeps first entry, entryCount = 1", async () => {
    const entry1 = makeEntry("at/first-hafas-mgate", "collision:");
    const entry2 = makeEntry("de/second-hafas-mgate", "collision:");
    vi.mocked(fetchRegistryEntries).mockResolvedValue([entry1, entry2]);

    await registry.initialize();

    expect(registry.entryCount).toBe(1);
    const found = registry.findByPrefix("collision:");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("at/first-hafas-mgate");
  });

  it("findProviders(viennaBbox) → returns oebb (covers Vienna), not NYC entry", async () => {
    // Vienna bbox: roughly [16.2, 48.1, 16.6, 48.3]
    const viennaBbox: [number, number, number, number] = [16.2, 48.1, 16.6, 48.3];

    // ÖBB covers Austria [9.53, 46.37, 17.16, 49.02] — overlaps Vienna
    const oebbEntry = makeEntry(
      "at/oebb-hafas-mgate",
      "oebb:",
      "hafasMgate",
      [9.53, 46.37, 17.16, 49.02],
    );
    // NYC entry covers roughly [-74.3, 40.5, -73.7, 40.9] — does NOT overlap Vienna
    const nycEntry = makeEntry(
      "us/nyc-mta-otp-graphql",
      "nyc:",
      "otpGraphQl",
      [-74.3, 40.5, -73.7, 40.9],
    );

    vi.mocked(fetchRegistryEntries).mockResolvedValue([oebbEntry, nycEntry]);

    await registry.initialize();

    const providers = registry.findProviders(viennaBbox);

    // ÖBB should be found, NYC should not
    expect(providers.some((e) => e.id === "at/oebb-hafas-mgate")).toBe(true);
    expect(providers.some((e) => e.id === "us/nyc-mta-otp-graphql")).toBe(false);

    // NYC bbox should not overlap Vienna
    const nycProviders = registry.findProviders([-74.3, 40.5, -73.7, 40.9]);
    expect(nycProviders.some((e) => e.id === "us/nyc-mta-otp-graphql")).toBe(true);
    expect(nycProviders.some((e) => e.id === "at/oebb-hafas-mgate")).toBe(false);
  });

  it("listProviders() → returns correct slug/label/url", async () => {
    const entryWithAttribution: RegistryEntry = {
      id: "at/oebb-hafas-mgate",
      slug: "oebb",
      prefix: "oebb:",
      name: "ÖBB",
      protocol: "hafasMgate",
      supportedLanguages: ["de"],
      options: {},
      coverage: { bbox: [9.53, 46.37, 17.16, 49.02], tiers: [] },
      attribution: {
        name: "Österreichische Bundesbahnen",
        homepage: "https://www.oebb.at",
      },
    };

    vi.mocked(fetchRegistryEntries).mockResolvedValue([entryWithAttribution]);

    await registry.initialize();

    const providers = registry.listProviders();
    expect(providers.length).toBe(1);
    const p = providers[0];
    expect(p.slug).toBe("oebb");
    expect(p.label).toBe("Österreichische Bundesbahnen"); // attribution.name takes precedence
    expect(p.url).toBe("https://www.oebb.at");
  });

  it("listProviders() uses entry.name as label when attribution is absent", async () => {
    const entryNoAttribution = makeEntry("fr/sncf-hafas-mgate", "sncf:");
    // Override name for clarity
    entryNoAttribution.name = "SNCF";
    vi.mocked(fetchRegistryEntries).mockResolvedValue([entryNoAttribution]);

    await registry.initialize();

    const providers = registry.listProviders();
    expect(providers[0].label).toBe("SNCF");
    expect(providers[0].url).toBe("");
  });
});
