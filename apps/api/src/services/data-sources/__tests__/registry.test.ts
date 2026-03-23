import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataSourceProvider } from "../types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadRegistry() {
  vi.resetModules();
  const mod = await import("../registry.js");
  return mod.dataSourceRegistry;
}

function makeProvider(id: string): DataSourceProvider {
  return {
    id,
    meta: {
      id,
      name: `Provider ${id}`,
      attribution: { text: id, url: `https://${id}.example` },
      categoryChipLabel: id,
      minZoom: 10,
      markerStyle: { variantColors: {}, defaultColor: "#000", inactiveOpacity: 0.4, iconPath: "" },
      placeCategory: `Test ${id}`,
      placeCategoryRaw: id,
    },
    async getFilters() {
      return [];
    },
    async search() {
      return [];
    },
    async getDetail(itemId: string) {
      return {
        id: itemId,
        source: id,
        name: `Detail ${id}`,
        coordinates: [0, 0] as [number, number],
        attribution: { text: id, url: "" },
        sections: [],
      };
    },
  };
}

// register + get

describe("DataSourceRegistry.register + get", () => {
  it("registers a provider and retrieves it by id", async () => {
    const registry = await loadRegistry();
    const provider = makeProvider("ev-charging");

    registry.register(provider);
    const result = registry.get("ev-charging");

    expect(result).toBe(provider);
    expect(result?.id).toBe("ev-charging");
  });

  it("returns undefined for unknown id", async () => {
    const registry = await loadRegistry();

    const result = registry.get("nonexistent");
    expect(result).toBeUndefined();
  });
});

// getAll

describe("DataSourceRegistry.getAll", () => {
  it("returns all registered providers", async () => {
    const registry = await loadRegistry();
    const p1 = makeProvider("fuel");
    const p2 = makeProvider("parking");
    const p3 = makeProvider("bike-sharing");

    registry.register(p1);
    registry.register(p2);
    registry.register(p3);

    const all = registry.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((p) => p.id).sort()).toEqual(["bike-sharing", "fuel", "parking"]);
  });

  it("returns empty array when no providers registered", async () => {
    const registry = await loadRegistry();
    expect(registry.getAll()).toEqual([]);
  });
});

// Re-registration

describe("DataSourceRegistry re-registration", () => {
  it("re-registering with same id overwrites the previous provider", async () => {
    const registry = await loadRegistry();
    const original = makeProvider("ev-charging");
    const replacement = makeProvider("ev-charging");

    registry.register(original);
    expect(registry.get("ev-charging")).toBe(original);

    registry.register(replacement);
    expect(registry.get("ev-charging")).toBe(replacement);
    expect(registry.get("ev-charging")).not.toBe(original);

    // Only one provider in the registry
    expect(registry.getAll()).toHaveLength(1);
  });
});

// Isolation via resetModules

describe("DataSourceRegistry isolation", () => {
  it("each loadRegistry call returns a fresh empty registry", async () => {
    const registry1 = await loadRegistry();
    registry1.register(makeProvider("fuel"));
    expect(registry1.getAll()).toHaveLength(1);

    const registry2 = await loadRegistry();
    expect(registry2.getAll()).toHaveLength(0);
  });
});
