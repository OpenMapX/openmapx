import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  values: new Map<string, string>(),
  get: vi.fn(),
  eval: vi.fn(),
  fetch: vi.fn(),
  available: true,
}));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../redis", () => ({
  get redis() {
    return ports.available
      ? {
          get: ports.get,
          eval: ports.eval,
          set: async (key: string, value: string) => ports.values.set(key, value),
          setex: async (key: string, _ttl: number, value: string) => ports.values.set(key, value),
        }
      : null;
  },
}));
vi.mock("@openmapx/core/server", async (original) => ({
  ...(await original<typeof import("@openmapx/core/server")>()),
  safeFetchJson: (...args: unknown[]) => ports.fetch(...args),
}));
vi.mock("../app-logger", () => ({ appLogger: { add: vi.fn() } }));

import {
  addExtensionSource,
  getExtensionCatalog,
  listExtensionSources,
  removeExtensionSource,
} from "../extension-store";

import { EDIT_EXTENSION_SOURCES, PUBLISH_EXTENSION_CATALOG } from "../extension-store-cache";

const sourceKey = "extstore:extra_sources";
const catalogKey = "extstore:catalog";
const extraUrl = "https://extra.example.test/catalog.json";
const source = { url: extraUrl, label: "Extra", isDefault: false };
const entry = { id: "extra", name: "Extra" };
const old = JSON.stringify({
  entries: [{ id: "old", name: "Old" }],
  killSwitch: { removed: [], critical: [] },
});
const empty = JSON.stringify({ entries: [], killSwitch: { removed: [], critical: [] } });

// The storage boundary models atomic CAS schedules, not Lua execution. The
// separately gated pinned-Valkey suite executes the actual scripts.
async function atomic(_script: string, count: number, ...args: string[]) {
  expect(count).toBe(2);
  const [sources, catalog, sourcePresent, observedSource, ...rest] = args;
  expect(_script).toBe(rest.length === 1 ? EDIT_EXTENSION_SOURCES : PUBLISH_EXTENSION_CATALOG);
  const matches = (key: string, present: string, value: string) =>
    present === "0" ? !ports.values.has(key) : ports.values.get(key) === value;
  if (!matches(sources, sourcePresent, observedSource)) return 0;
  if (rest.length === 1) {
    ports.values.delete(catalog);
    ports.values.set(sources, rest[0]);
  } else {
    const [catalogPresent, observedCatalog, next] = rest;
    if (!matches(catalog, catalogPresent, observedCatalog)) return 0;
    ports.values.set(catalog, next);
  }
  return 1;
}

beforeEach(() => {
  vi.resetAllMocks();
  ports.available = true;
  ports.values.clear();
  ports.get.mockImplementation(async (key: string) => ports.values.get(key) ?? null);
  ports.eval.mockImplementation(atomic);
  ports.fetch.mockImplementation(async (url: string) => (url === extraUrl ? [entry] : []));
});

describe("extension source and catalog coherence", () => {
  it("add then ordinary read includes the added source instead of the old cache", async () => {
    ports.values.set(catalogKey, old);
    await addExtensionSource(extraUrl, "Extra");
    expect(await getExtensionCatalog()).toEqual([{ ...entry, trust: "community" }]);
  });
  it("remove then ordinary read excludes the removed source", async () => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    ports.values.set(catalogKey, old);
    await removeExtensionSource(extraUrl);
    expect(await getExtensionCatalog()).toEqual([]);
  });
  it("persists a valid empty forced refresh over an old nonempty snapshot", async () => {
    ports.values.set(catalogKey, old);
    expect(await getExtensionCatalog(true)).toEqual([]);
    expect(await getExtensionCatalog()).toEqual([]);
    expect(ports.values.get(catalogKey)).toBe(empty);
  });
  it("rejects a build paused across a completed source edit", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    ports.fetch.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [{ id: "obsolete", name: "Obsolete" }];
    });
    const pending = getExtensionCatalog(true);
    const outcome = expect(pending).rejects.toMatchObject({ category: "catalog_conflict" });
    await entered.promise;
    try {
      await addExtensionSource(extraUrl, "Extra");
    } finally {
      release.resolve();
    }
    await outcome;
    expect(await getExtensionCatalog()).toEqual([{ ...entry, trust: "community" }]);
  });
  it("rejects a slow old build after a later empty refresh with identical sources", async () => {
    ports.values.set(catalogKey, old);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    ports.fetch.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [{ id: "obsolete", name: "Obsolete" }];
    });
    const pending = getExtensionCatalog(true);
    const outcome = expect(pending).rejects.toMatchObject({ category: "catalog_conflict" });
    await entered.promise;
    try {
      expect(await getExtensionCatalog(true)).toEqual([]);
    } finally {
      release.resolve();
    }
    await outcome;
    expect(await getExtensionCatalog()).toEqual([]);
  });
  it("rejects one concurrent edit without losing the completed edit or retrying it", async () => {
    const results = await Promise.allSettled([
      addExtensionSource(extraUrl, "Extra"),
      addExtensionSource("https://second.example.test/catalog.json", "Second"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([
      { reason: { category: "source_conflict" } },
    ]);
    expect(JSON.parse(ports.values.get(sourceKey) as string)).toHaveLength(1);
    expect(ports.eval).toHaveBeenCalledTimes(2);
  });
  it.each(["add", "remove"])("%s fails closed on a source read error", async (operation) => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    ports.values.set(catalogKey, old);
    ports.get.mockRejectedValue(new Error("synthetic private storage details"));
    const change =
      operation === "add"
        ? addExtensionSource("https://second.example.test/catalog.json", "Second")
        : removeExtensionSource(extraUrl);
    await expect(change).rejects.toMatchObject({ category: "source_storage_unavailable" });
    expect(ports.values.get(sourceKey)).toBe(JSON.stringify([source]));
    expect(ports.values.get(catalogKey)).toBe(old);
    expect(ports.eval).not.toHaveBeenCalled();
  });
  it.each(["add", "remove"])("%s cannot claim success without Redis", async (operation) => {
    ports.available = false;
    await expect(
      operation === "add" ? addExtensionSource(extraUrl, "Extra") : removeExtensionSource(extraUrl),
    ).rejects.toMatchObject({ category: "source_storage_unavailable" });
  });
  it.each(["", "null", "{}", "[null]", '[{"url":"x","label":"X","isDefault":true}]'])(
    "rejects corrupt source bytes %j without replacing them",
    async (raw) => {
      ports.values.set(sourceKey, raw);
      await expect(addExtensionSource(extraUrl, "Extra")).rejects.toMatchObject({
        category: "invalid_source_snapshot",
      });
      expect(ports.values.get(sourceKey)).toBe(raw);
      expect(ports.eval).not.toHaveBeenCalled();
    },
  );
  it("preserves absent/default removal and duplicate add no-ops without cache invalidation", async () => {
    ports.values.set(catalogKey, old);
    const [defaultSource] = await listExtensionSources();
    await removeExtensionSource(defaultSource.url);
    await removeExtensionSource("not a URL");
    expect(ports.values.has(sourceKey)).toBe(false);
    ports.values.set(sourceKey, JSON.stringify([source]));
    await addExtensionSource(extraUrl, "Changed label");
    expect(ports.values.get(sourceKey)).toBe(JSON.stringify([source]));
    expect(ports.values.get(catalogKey)).toBe(old);
    expect(ports.eval).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "rejects failed empty acquisition (previous cache: %s)",
    async (cached) => {
      const denied = JSON.stringify({
        entries: [{ id: "old", name: "Old" }],
        killSwitch: { removed: [["old", "delisted"]], critical: [["old", { reason: "security" }]] },
      });
      if (cached) ports.values.set(catalogKey, denied);
      ports.fetch.mockRejectedValue(new Error("synthetic provider private details"));
      await expect(getExtensionCatalog(true)).rejects.toMatchObject({
        category: "catalog_acquisition_failed",
      });
      expect(ports.values.get(catalogKey)).toBe(cached ? denied : undefined);
      expect(ports.eval).not.toHaveBeenCalled();
    },
  );
  it("does not certify a build when publication fails", async () => {
    ports.values.set(catalogKey, old);
    ports.eval.mockRejectedValue(new Error("synthetic storage secret"));
    await expect(getExtensionCatalog(true)).rejects.toMatchObject({
      category: "source_storage_unavailable",
    });
    expect(ports.values.get(catalogKey)).toBe(old);
    expect(ports.eval).toHaveBeenCalledTimes(1);
  });
  it("keeps current sources and reports failure if invalidation fails", async () => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    ports.values.set(catalogKey, old);
    ports.eval.mockRejectedValue(new Error("synthetic invalidation failure"));
    await expect(removeExtensionSource(extraUrl)).rejects.toMatchObject({
      category: "source_storage_unavailable",
    });
    expect(ports.values.get(sourceKey)).toBe(JSON.stringify([source]));
    expect(ports.values.get(catalogKey)).toBe(old);
    expect(ports.eval).toHaveBeenCalledTimes(1);
  });
  it("reports a failed source SET after cache loss without retry or false success", async () => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    ports.values.set(catalogKey, old);
    ports.eval.mockImplementation(async () => {
      ports.values.delete(catalogKey);
      throw new Error("synthetic SET failure");
    });
    await expect(removeExtensionSource(extraUrl)).rejects.toMatchObject({
      category: "source_storage_unavailable",
    });
    expect(ports.values.get(sourceKey)).toBe(JSON.stringify([source]));
    expect(ports.values.has(catalogKey)).toBe(false);
    expect(ports.eval).toHaveBeenCalledTimes(1);
  });
  it("treats lost acknowledgement after execution as failure, without compensation or retry", async () => {
    ports.values.set(catalogKey, old);
    ports.eval.mockImplementation(async (...args: Parameters<typeof atomic>) => {
      await atomic(...args);
      throw new Error("synthetic disconnect");
    });
    await expect(addExtensionSource(extraUrl, "Extra")).rejects.toMatchObject({
      category: "source_storage_unavailable",
    });
    expect(ports.values.get(sourceKey)).toBe(JSON.stringify([source]));
    expect(ports.values.has(catalogKey)).toBe(false);
    expect(ports.eval).toHaveBeenCalledTimes(1);
  });
  it("keeps inert source fields and compares original bytes without normalizing them", async () => {
    const persisted =
      '[ { "url": "https://extra.example.test/catalog.json", "label": "Extra", "isDefault": false, "inert": { "x": 1 } } ]';
    ports.values.set(sourceKey, persisted);
    await addExtensionSource("https://second.example.test/catalog.json", "Second");
    expect(JSON.parse(ports.values.get(sourceKey) as string)[0]).toEqual({
      ...source,
      inert: { x: 1 },
    });
    expect(ports.eval.mock.calls[0][5]).toBe(persisted);
  });
  it.each([false, true])(
    "rejects catalog read failures without building (forced: %s)",
    async (force) => {
      ports.get.mockImplementation(async (key: string) => {
        if (key === catalogKey) throw new Error("synthetic private read error");
        return null;
      });
      await expect(getExtensionCatalog(force)).rejects.toMatchObject({
        category: "source_storage_unavailable",
      });
      expect(ports.fetch).not.toHaveBeenCalled();
      expect(ports.eval).not.toHaveBeenCalled();
    },
  );
  it.each(["", "null", "{}", '{"entries":[],"killSwitch":{"removed":[],"critical":[["x",null]]}}'])(
    "does not turn corrupt catalog %j into an empty success",
    async (raw) => {
      ports.values.set(catalogKey, raw);
      await expect(getExtensionCatalog()).rejects.toMatchObject({
        category: "invalid_catalog_snapshot",
      });
      expect(ports.values.get(catalogKey)).toBe(raw);
      expect(ports.eval).not.toHaveBeenCalled();
    },
  );
  it("can deliberately refresh a corrupt catalog using its exact observed bytes", async () => {
    ports.values.set(catalogKey, "invalid");
    expect(await getExtensionCatalog(true)).toEqual([]);
    expect(ports.values.get(catalogKey)).toBe(empty);
  });
  it("preserves nonempty partial acquisition and default-only reads without configured storage", async () => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    ports.fetch.mockImplementation(async (url: string) => {
      if (url === extraUrl) return [entry];
      throw new Error("synthetic provider failure");
    });
    expect(await getExtensionCatalog(true)).toEqual([{ ...entry, trust: "community" }]);
    ports.available = false;
    ports.fetch.mockResolvedValue([entry]);
    expect(await listExtensionSources()).toHaveLength(1);
    expect(await getExtensionCatalog()).toHaveLength(1);
  });
  it("rejects a pending removal when a completed add changed the observed source bytes", async () => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    ports.eval.mockImplementationOnce(async (...args: Parameters<typeof atomic>) => {
      entered.resolve();
      await release.promise;
      return atomic(...args);
    });
    const pending = removeExtensionSource(extraUrl);
    const outcome = expect(pending).rejects.toMatchObject({ category: "source_conflict" });
    await entered.promise;
    try {
      await addExtensionSource("https://second.example.test/catalog.json", "Second");
    } finally {
      release.resolve();
    }
    await outcome;
    expect(JSON.parse(ports.values.get(sourceKey) as string)).toEqual([
      source,
      { url: "https://second.example.test/catalog.json", label: "Second", isDefault: false },
    ]);
    expect(ports.eval).toHaveBeenCalledTimes(2);
  });
  it("does not acknowledge an explicit refresh without configured persistence", async () => {
    ports.available = false;
    await expect(getExtensionCatalog(true)).rejects.toMatchObject({
      category: "source_storage_unavailable",
    });
    expect(ports.fetch).not.toHaveBeenCalled();
  });
});
