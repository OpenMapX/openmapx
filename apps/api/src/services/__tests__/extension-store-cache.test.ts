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
  getKillSwitch,
  listExtensionSources,
  removeExtensionSource,
  scrubExtensionStoreUrlState,
} from "../extension-store";

import {
  EDIT_EXTENSION_SOURCES,
  PUBLISH_EXTENSION_CATALOG,
  REPAIR_EXTENSION_URL_STATE,
} from "../extension-store-cache";

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
  const matches = (key: string, present: string, value: string) =>
    present === "0" ? !ports.values.has(key) : ports.values.get(key) === value;
  if (!matches(sources, sourcePresent, observedSource)) return 0;
  if (rest.length === 1) {
    expect(_script).toBe(EDIT_EXTENSION_SOURCES);
    ports.values.delete(catalog);
    ports.values.set(sources, rest[0]);
  } else if (rest.length === 3) {
    expect(_script).toBe(REPAIR_EXTENSION_URL_STATE);
    const [catalogPresent, observedCatalog, next] = rest;
    if (!matches(catalog, catalogPresent, observedCatalog)) return -1;
    ports.values.delete(catalog);
    ports.values.set(sources, next);
  } else {
    expect(_script).toBe(PUBLISH_EXTENSION_CATALOG);
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
  it.each([
    "http://catalog.example.test/catalog.json",
    "https://catalog.example.test/catalog.json?token=secret",
  ])("rejects an unsafe configured default source before acquisition: %s", async (url) => {
    vi.stubEnv("EXTENSION_CATALOG_URL", url);
    vi.resetModules();
    try {
      const isolated = await import("../extension-store");
      await expect(isolated.getExtensionCatalog(true)).rejects.toBeDefined();
      expect(ports.fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("atomically drops legacy secret-bearing sources and invalidates their catalog", async () => {
    const unsafe = [
      "https://user:password@example.test/catalog.json",
      "https://example.test/catalog.json?token=secret",
      "https://example.test/catalog.json#secret",
    ].map((url, index) => ({ url, label: `Unsafe ${index}`, isDefault: false }));
    ports.values.set(sourceKey, JSON.stringify([...unsafe, source]));
    ports.values.set(catalogKey, old);

    await scrubExtensionStoreUrlState();

    expect(JSON.parse(ports.values.get(sourceKey) as string)).toEqual([source]);
    expect(ports.values.has(catalogKey)).toBe(false);
    expect(ports.eval).toHaveBeenCalledTimes(1);
    expect(ports.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      id: "unsafe-manifest",
      name: "Unsafe manifest",
      manifest: "https://example.test/extension.json?token=secret",
    },
    {
      id: "unsafe-inline",
      name: "Unsafe inline",
      version: "1.0.0",
      integrations: [
        {
          id: "unsafe-inline",
          artifact: "https://example.test/archive.tgz#secret",
          sha256: "a".repeat(64),
        },
      ],
    },
  ])("invalidates a cached entry with an unsafe durable locator", async (cachedEntry) => {
    const sources = JSON.stringify([source]);
    ports.values.set(sourceKey, sources);
    ports.values.set(
      catalogKey,
      JSON.stringify({
        entries: [cachedEntry],
        killSwitch: { removed: [], critical: [] },
      }),
    );

    await scrubExtensionStoreUrlState();

    expect(ports.values.get(sourceKey)).toBe(sources);
    expect(ports.values.has(catalogKey)).toBe(false);
    expect(ports.eval).toHaveBeenCalledTimes(1);
  });

  it("normalizes partial catalog components without losing metadata or requiring a version", async () => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    const manifest = "https://MANIFEST.example.test:443/releases/../extension.json";
    const canonicalManifest = "https://manifest.example.test/extension.json";
    const emptyManifest = "https://manifest.example.test/empty.json";
    const item = {
      id: "partial",
      name: "Partial",
      manifest,
      integrations: [
        {
          id: "partial",
          artifact: "https://ARTIFACTS.example.test:443/releases/../partial.tgz",
          sha256: "a".repeat(64),
          metadata: { retained: [1, false, null] },
        },
      ],
      services: [
        {
          service: "partial-service",
          repo: "https://github.com/openmapx/example.git",
          metadata: { retained: true },
        },
      ],
    };
    const emptyItem = {
      id: "empty-components",
      name: "Empty components",
      manifest: emptyManifest,
      services: [],
      integrations: [],
      metadata: { retained: "empty" },
    };
    ports.fetch.mockImplementation(async (url: string) => {
      if (url === extraUrl) return [item, emptyItem];
      if (url === canonicalManifest) return { version: "2.0.0" };
      if (url === emptyManifest) return { version: "3.0.0" };
      throw new Error("unexpected fixture URL");
    });

    await expect(getExtensionCatalog(true)).resolves.toEqual([
      {
        ...item,
        manifest: canonicalManifest,
        version: "2.0.0",
        integrations: [
          {
            ...item.integrations[0],
            artifact: "https://artifacts.example.test/partial.tgz",
          },
        ],
        trust: "community",
      },
      { ...emptyItem, version: "3.0.0", trust: "community" },
    ]);
  });

  it("does not overwrite a concurrent source edit while repairing", async () => {
    const unsafeRaw = JSON.stringify([
      source,
      {
        url: "https://example.test/catalog.json?token=secret",
        label: "Unsafe",
        isDefault: false,
      },
    ]);
    ports.values.set(sourceKey, unsafeRaw);
    ports.values.set(catalogKey, old);
    ports.eval.mockResolvedValueOnce(0);

    await expect(scrubExtensionStoreUrlState()).rejects.toMatchObject({
      category: "source_conflict",
    });
    expect(ports.values.get(sourceKey)).toBe(unsafeRaw);
    expect(ports.values.get(catalogKey)).toBe(old);
    expect(ports.eval).toHaveBeenCalledTimes(1);
  });

  it("does not delete a concurrent catalog publication while repairing", async () => {
    const sources = JSON.stringify([source]);
    const unsafeCatalog = JSON.stringify({
      entries: [
        {
          id: "unsafe",
          name: "Unsafe",
          manifest: "https://example.test/extension.json?token=secret",
        },
      ],
    });
    const newer = JSON.stringify({
      entries: [{ id: "newer", name: "Newer" }],
      killSwitch: { removed: ["revoked"], critical: [] },
    });
    ports.values.set(sourceKey, sources);
    ports.values.set(catalogKey, unsafeCatalog);
    ports.eval.mockImplementationOnce(async (script: string, count: number, ...args: string[]) => {
      ports.values.set(catalogKey, newer);
      return atomic(script, count, ...args);
    });

    await expect(scrubExtensionStoreUrlState()).rejects.toMatchObject({
      category: "catalog_conflict",
    });
    expect(ports.values.get(sourceKey)).toBe(sources);
    expect(ports.values.get(catalogKey)).toBe(newer);
  });

  it("rebuilds from remaining sources when another acquisition fails after repair", async () => {
    const unsafeUrl = "https://example.test/catalog.json?token=secret";
    ports.values.set(
      sourceKey,
      JSON.stringify([{ url: unsafeUrl, label: "Unsafe", isDefault: false }, source]),
    );
    ports.values.set(catalogKey, old);
    ports.fetch.mockImplementation(async (requested: string) => {
      if (requested === extraUrl) return [entry];
      throw new Error("synthetic default acquisition failure");
    });

    await scrubExtensionStoreUrlState();
    await expect(getExtensionCatalog()).resolves.toEqual([{ ...entry, trust: "community" }]);
    expect(ports.fetch.mock.calls.some(([requested]) => requested === unsafeUrl)).toBe(false);
  });

  it("fails closed when repair cannot read or atomically own storage", async () => {
    ports.values.set(sourceKey, JSON.stringify([source]));
    ports.get.mockRejectedValueOnce(new Error("synthetic storage details"));
    await expect(scrubExtensionStoreUrlState()).rejects.toMatchObject({
      category: "source_storage_unavailable",
    });
    expect(ports.eval).not.toHaveBeenCalled();
  });

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
  describe("provider document classification", () => {
    const denied = JSON.stringify({
      entries: [{ id: "old", name: "Old" }],
      killSwitch: { removed: [["old", "delisted"]], critical: [["old", { reason: "security" }]] },
    });
    const malformed: [string, unknown][] = [
      ["scalar", 42],
      ["null", null],
      ["false", false],
      ["empty string", ""],
      ["wrong extensions", { extensions: "invalid" }],
      ["null extensions", { extensions: null }],
      ["false extensions", { extensions: false }],
      ["zero extensions", { extensions: 0 }],
      ["empty string extensions", { extensions: "" }],
      ["present undefined extensions", { extensions: undefined }],
      ["object extensions", { extensions: {} }],
      ["null removed", { removed: null }],
      ["empty string removed", { removed: "" }],
      ["object removed", { removed: {} }],
      ["present undefined removed", { removed: undefined }],
      ["null critical", { critical: null }],
      ["empty string critical", { critical: "" }],
      ["object critical", { critical: {} }],
      ["present undefined critical", { critical: undefined }],
      ["null removed item", { removed: [null] }],
      ["missing removed id", { removed: [{}] }],
      ["null removed reason", { removed: [{ id: "old", reason: null }] }],
      ["invalid critical item", { critical: [42] }],
      ["missing critical id", { critical: [{}] }],
      ["invalid critical id", { critical: [{ id: 42 }] }],
      ["invalid critical reason", { critical: [{ id: "old", reason: false }] }],
      ["null maxVersion", { critical: [{ id: "old", maxVersion: null }] }],
      ["invalid maxVersion", { critical: [{ id: "old", maxVersion: 42 }] }],
      ["null entry", [null]],
      ["scalar entry", [42]],
      ["missing entry identity", [{}]],
      ["invalid entry name", [{ id: "x", name: false }]],
      ["valid entry followed by invalid entry", [entry, null]],
      ["valid entry with invalid controls", { extensions: [entry], critical: null }],
    ];
    it.each(malformed)(
      "rejects %s without changing warm or cold catalog bytes",
      async (_name, payload) => {
        ports.fetch.mockResolvedValue(payload);
        for (const cached of [true, false]) {
          if (cached) ports.values.set(catalogKey, denied);
          else ports.values.delete(catalogKey);
          await expect(getExtensionCatalog(true)).rejects.toMatchObject({
            category: "catalog_acquisition_failed",
          });
          expect(ports.values.get(catalogKey)).toBe(cached ? denied : undefined);
        }
        expect(ports.eval).not.toHaveBeenCalled();
        expect(ports.fetch).toHaveBeenCalledTimes(2);
      },
    );
    it.each([
      [],
      {},
      { extensions: [] },
      { removed: [], critical: [] },
      {
        extensions: [],
        removed: [],
        critical: [],
        editorial: { arbitrary: [null, "retained input"] },
      },
    ])("publishes supported valid empty document %j", async (payload) => {
      ports.values.set(catalogKey, denied);
      ports.fetch.mockResolvedValue(payload);
      expect(await getExtensionCatalog(true)).toEqual([]);
      expect(ports.values.get(catalogKey)).toBe(empty);
      expect(await getExtensionCatalog()).toEqual([]);
    });
    it("publishes a control-only object without losing empty-string reasons or opaque version metadata", async () => {
      ports.values.set(catalogKey, denied);
      const controls = {
        removed: [{ id: "removed", reason: "" }, { id: "default-reason" }],
        critical: [
          { id: "critical", reason: "", maxVersion: "arbitrary-version", inert: [null] },
          { id: "default-critical" },
        ],
      };
      ports.fetch.mockResolvedValue(controls);
      expect(await getExtensionCatalog(true)).toEqual([]);
      expect(JSON.parse(ports.values.get(catalogKey) as string)).toEqual({
        entries: [],
        killSwitch: {
          removed: [
            ["removed", ""],
            ["default-reason", "delisted"],
          ],
          critical: [
            ["critical", { reason: "", maxVersion: "arbitrary-version" }],
            ["default-critical", { reason: "security advisory" }],
          ],
        },
      });
    });
    it.each(["bare", "object"])("preserves inert entry metadata in %s catalogs", async (form) => {
      const item = {
        ...entry,
        version: "opaque version",
        inert: { nested: [1, false, null, { arbitrary: "value" }] },
      };
      ports.fetch.mockResolvedValue(
        form === "bare" ? [item] : { extensions: [item], editorial: { arbitrary: true } },
      );
      expect(await getExtensionCatalog(true)).toEqual([{ ...item, trust: "community" }]);
      expect(await getExtensionCatalog()).toEqual([{ ...item, trust: "community" }]);
    });
    it("retains the intentional nonempty partial-source policy when another source is malformed", async () => {
      ports.values.set(sourceKey, JSON.stringify([source]));
      ports.fetch.mockImplementation(async (url: string) =>
        url === extraUrl ? [entry] : { extensions: "invalid" },
      );
      expect(await getExtensionCatalog(true)).toEqual([{ ...entry, trust: "community" }]);
      expect(await getExtensionCatalog()).toEqual([{ ...entry, trust: "community" }]);
    });
    it("does not change the independent moving-feed failure/stale behavior", async () => {
      ports.values.set(catalogKey, denied);
      ports.values.set(
        "extstore:revocations",
        JSON.stringify({ removed: [["feed", "retained"]], critical: [], fetchedAtMs: 1 }),
      );
      ports.fetch.mockRejectedValue(new Error("synthetic feed failure"));
      const result = await getKillSwitch();
      expect(result.stale).toBe(true);
      expect(result.removed.get("feed")).toBe("retained");
      expect(result.removed.get("old")).toBe("delisted");
      expect(result.critical.get("old")).toEqual({ reason: "security" });
      expect(ports.values.get(catalogKey)).toBe(denied);
    });
  });
});
