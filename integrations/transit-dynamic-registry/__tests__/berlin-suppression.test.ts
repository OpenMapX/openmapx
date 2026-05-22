import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryEntry } from "../registry-types";

vi.mock("../fetcher", () => ({
  fetchRegistryEntries: vi.fn(),
}));

import { fetchRegistryEntries } from "../fetcher";
import { registry } from "../registry";

const BERLIN_BBOX_INNER: [number, number, number, number] = [13.4, 52.5, 13.41, 52.51];

const VBB_ENTRY: RegistryEntry = {
  id: "de/vbb-hafas-mgate",
  slug: "vbb",
  prefix: "vbb:",
  name: "VBB",
  protocol: "hafasMgate",
  supportedLanguages: ["de"],
  timezone: "Europe/Berlin",
  options: {},
  coverage: {
    bbox: [11.26, 51.36, 14.77, 53.56],
    tiers: [
      {
        level: "regularCoverage",
        bbox: [11.26, 51.36, 14.77, 53.56],
        regions: ["DE-BE", "DE-BB"],
      },
    ],
  },
  attribution: { name: "VBB" },
};

const BVG_ENTRY: RegistryEntry = {
  id: "de/bvg-hafas-mgate",
  slug: "bvg",
  prefix: "bvg:",
  name: "BVG",
  protocol: "hafasMgate",
  supportedLanguages: ["de"],
  timezone: "Europe/Berlin",
  options: {},
  coverage: {
    bbox: [13.08, 52.33, 13.77, 52.68],
    tiers: [
      {
        level: "regularCoverage",
        bbox: [13.08, 52.33, 13.77, 52.68],
        regions: ["DE-BE"],
      },
    ],
  },
  attribution: { name: "BVG" },
};

const DB_ENTRY: RegistryEntry = {
  id: "de/db-hafas-mgate",
  slug: "db",
  prefix: "db:",
  name: "DB",
  protocol: "hafasMgate",
  supportedLanguages: ["de"],
  timezone: "Europe/Berlin",
  options: {},
  coverage: {
    bbox: [5.87, 47.27, 15.04, 55.06],
    tiers: [
      {
        level: "regularCoverage",
        bbox: [5.87, 47.27, 15.04, 55.06],
        regions: ["DE"],
      },
    ],
  },
  attribution: { name: "DB" },
};

describe("transit-dynamic-registry Berlin suppression", () => {
  beforeEach(() => {
    vi.mocked(fetchRegistryEntries).mockReset();
  });

  it("loads vbb and bvg dynamic entries (no longer suppressed after C1)", async () => {
    vi.mocked(fetchRegistryEntries).mockResolvedValue([VBB_ENTRY, BVG_ENTRY, DB_ENTRY]);

    await registry.initialize();

    const entries = registry.listEntries();
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("de/vbb-hafas-mgate");
    expect(ids).toContain("de/bvg-hafas-mgate");
    expect(ids).not.toContain("de/db-hafas-mgate");
  });

  it("returns a Berlin-covering provider for a stop near Brandenburg Gate", async () => {
    vi.mocked(fetchRegistryEntries).mockResolvedValue([VBB_ENTRY, BVG_ENTRY, DB_ENTRY]);

    await registry.initialize();

    // bbox around lat 52.5200, lng 13.4050 (Brandenburg Gate)
    const providers = registry.findProviders(BERLIN_BBOX_INNER);
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("de/vbb-hafas-mgate");
    expect(ids).toContain("de/bvg-hafas-mgate");
  });

  it("findByPrefix resolves bvg: and vbb: prefixes", async () => {
    vi.mocked(fetchRegistryEntries).mockResolvedValue([VBB_ENTRY, BVG_ENTRY]);

    await registry.initialize();

    expect(registry.findByPrefix("vbb:")?.id).toBe("de/vbb-hafas-mgate");
    expect(registry.findByPrefix("bvg:")?.id).toBe("de/bvg-hafas-mgate");
  });
});
