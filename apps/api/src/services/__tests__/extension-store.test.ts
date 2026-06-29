import { describe, expect, it, vi } from "vitest";

// extension-store imports the db client + redis at module load; neither is used
// by applyLiveVersions (it only calls the injected fetcher), so stub them out.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../redis", () => ({ redis: null }));

import { applyLiveVersions, type ExtensionCatalogEntry } from "../extension-store.js";

function entry(over: Partial<ExtensionCatalogEntry>): ExtensionCatalogEntry {
  return { id: "x", name: "X", version: "0.0.0", ...over };
}

describe("applyLiveVersions", () => {
  it("overrides version + platform from the manifest url (the source of truth)", async () => {
    const e = entry({
      manifest: "https://ex/extension.json",
      version: "0.1.0",
      minPlatform: "1.0",
    });
    await applyLiveVersions([e], async () => ({ version: "0.2.0", platform: "1.1" }));
    expect(e.version).toBe("0.2.0");
    expect(e.minPlatform).toBe("1.1");
  });

  it("leaves inline entries (no manifest url) untouched and unfetched", async () => {
    const e = entry({ version: "0.1.0", minPlatform: "1.0" });
    const fetchMeta = vi.fn();
    await applyLiveVersions([e], fetchMeta);
    expect(fetchMeta).not.toHaveBeenCalled();
    expect(e.version).toBe("0.1.0");
  });

  it("falls back to the declared values when the manifest fetch fails", async () => {
    const e = entry({
      manifest: "https://ex/extension.json",
      version: "0.1.0",
      minPlatform: "1.0",
    });
    await applyLiveVersions([e], async () => null);
    expect(e.version).toBe("0.1.0");
    expect(e.minPlatform).toBe("1.0");
  });

  it("keeps the declared platform when the manifest omits it", async () => {
    const e = entry({
      manifest: "https://ex/extension.json",
      version: "0.1.0",
      minPlatform: "1.0",
    });
    await applyLiveVersions([e], async () => ({ version: "0.2.0" }));
    expect(e.version).toBe("0.2.0");
    expect(e.minPlatform).toBe("1.0");
  });

  it("resolves multiple entries concurrently", async () => {
    const a = entry({ id: "a", manifest: "https://ex/a.json", version: "1" });
    const b = entry({ id: "b", manifest: "https://ex/b.json", version: "1" });
    await applyLiveVersions([a, b], async (url) => ({
      version: url.includes("a.json") ? "2" : "3",
    }));
    expect(a.version).toBe("2");
    expect(b.version).toBe("3");
  });

  it("leaves version undefined when a manifest entry has no fallback and the fetch fails", async () => {
    const e = entry({ manifest: "https://ex/extension.json" });
    delete (e as { version?: string }).version;
    await applyLiveVersions([e], async () => null);
    // Never invents a version — the catalog needn't carry one; routes guard undefined.
    expect(e.version).toBeUndefined();
  });
});
