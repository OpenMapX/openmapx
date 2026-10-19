import { access, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSwissDatasets, extractZipEntryText } from "../datasets.js";
import { memoryCache, testHttp } from "./helpers.js";

const archiveBarrier = vi.hoisted(() => ({
  hold: false,
  reached: undefined as undefined | (() => void),
  release: undefined as undefined | Promise<void>,
  replace: undefined as undefined | (() => Promise<void>),
  closeError: false,
  createdDirectories: [] as string[],
  created: undefined as undefined | (() => void),
}));
vi.mock("node:fs/promises", async (load) => {
  const original = await load<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdtemp: async (...args: Parameters<typeof original.mkdtemp>) => {
      const directory = await original.mkdtemp(...args);
      if (String(args[0]).includes("/swiss-occupancy-")) {
        archiveBarrier.createdDirectories.push(String(directory));
        archiveBarrier.created?.();
      }
      return directory;
    },
    stat: async (...args: Parameters<typeof original.stat>) => {
      const stats = await original.stat(...args);
      const replace = archiveBarrier.replace;
      archiveBarrier.replace = undefined;
      await replace?.();
      return stats;
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const file = await original.open(...args);
      const close = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementation(async () => {
        await close();
        if (archiveBarrier.closeError) throw new Error("File close failed");
      });
      const stat = file.stat.bind(file);
      vi.spyOn(file, "stat").mockImplementation(async () => {
        const stats = await stat();
        const replace = archiveBarrier.replace;
        archiveBarrier.replace = undefined;
        await replace?.();
        return stats;
      });
      const read = file.readFile.bind(file);
      vi.spyOn(file, "readFile").mockImplementation(async () => {
        const bytes = await read();
        if (archiveBarrier.hold && String(args[0]).includes("swiss-occupancy")) {
          archiveBarrier.hold = false;
          archiveBarrier.reached?.();
          await archiveBarrier.release;
        }
        return bytes;
      });
      return file;
    },
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const bytes = await original.readFile(...args);
      if (archiveBarrier.hold && String(args[0]).includes("swiss-occupancy")) {
        archiveBarrier.hold = false;
        archiveBarrier.reached?.();
        await archiveBarrier.release;
      }
      return bytes;
    },
  };
});

const temporaryDirectories: string[] = [];

it("owns business receipts and fences invalidated fills per dataset instance", async () => {
  const sourceId = "opentransportdata-ch-go-realtime";
  const receipt = { sourceId, name: "Generation A" };
  const state = memoryCache();
  const csv = "sboid;abbreviationEn;complete\nch:1:sboid:1;SBB;YES";
  let release!: () => void;
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const fetchMock = vi.fn(async () => {
    reached();
    await pending;
    return new Response(csv, { headers: { "content-type": "text/csv" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const a = createSwissDatasets({
    http: testHttp(),
    cache: state.cache,
    contributors: { [sourceId]: [receipt] },
  });
  const first = a.loadSwissBusinessOrganisationDatasets();
  const sameAcquisition = a.loadSwissBusinessOrganisationDatasets();
  await started;
  state.invalidate();
  receipt.name = "Changed outside instance";
  release();
  expect((await first).entries[0]?.contributors).toContainEqual({ sourceId, name: "Generation A" });
  expect(await sameAcquisition).toBe(await first);
  await a.loadSwissBusinessOrganisationDatasets();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  await a.dispose();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  archiveBarrier.hold = false;
  archiveBarrier.replace = undefined;
  archiveBarrier.closeError = false;
  archiveBarrier.created = undefined;
  await Promise.all(
    archiveBarrier.createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Swiss occupancy forecast archive inputs", () => {
  it.each([
    ["2025-02-*", "123"],
    ["2025/02/03", "123"],
    ["2025..02", "123"],
    ["2025-02-03", "-123"],
  ])("returns null without touching the archive for unsafe tokens", async (opDate, operatorRef) => {
    const fetchMock = vi.fn(() => {
      throw new Error("archive should not be touched");
    });
    vi.stubGlobal("fetch", fetchMock);

    const datasets = createSwissDatasets({
      http: testHttp(),
      cache: memoryCache().cache,
      contributors: {},
    });
    await expect(
      datasets.loadSwissOccupancyForecastDataset(opDate, operatorRef),
    ).resolves.toBeNull();
    await datasets.dispose();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts the exact matching entry from an in-process ZIP archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-swiss-occupancy-"));
    temporaryDirectories.push(directory);
    const zipPath = join(directory, "fixture.zip");
    const entryName = "2025-02-03/operator-123.json";
    await writeFile(
      zipPath,
      zipSync({
        [entryName]: strToU8('{"operatorRef":"123","trains":[]}'),
        "2025-02-03/operator-123-other.json": strToU8('{"operatorRef":"other"}'),
      }),
    );

    await expect(extractZipEntryText(zipPath, entryName)).resolves.toBe(
      '{"operatorRef":"123","trains":[]}',
    );
  });

  it("extracts the inspected archive generation when its path is replaced during inspection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openmapx-swiss-occupancy-"));
    temporaryDirectories.push(directory);
    const zipPath = join(directory, "fixture.zip");
    const replacementPath = join(directory, "replacement.zip");
    const entryName = "2025-02-03/operator-123.json";
    await writeFile(zipPath, zipSync({ [entryName]: strToU8("original archive") }));
    await writeFile(replacementPath, zipSync({ [entryName]: strToU8("replacement archive") }));
    archiveBarrier.replace = () => rename(replacementPath, zipPath);
    await expect(extractZipEntryText(zipPath, entryName)).resolves.toBe("original archive");
    await expect(extractZipEntryText(zipPath, entryName)).resolves.toBe("replacement archive");
  });

  it.each([false, true])(
    "preserves archive extraction fallback despite a close failure (invalid archive: %s)",
    async (invalid) => {
      const directory = await mkdtemp(join(tmpdir(), "openmapx-swiss-occupancy-"));
      temporaryDirectories.push(directory);
      const zipPath = join(directory, "fixture.zip");
      const entryName = "2025-02-03/operator-123.json";
      await writeFile(
        zipPath,
        invalid ? "invalid archive" : zipSync({ [entryName]: strToU8("original archive") }),
      );
      archiveBarrier.closeError = true;
      await expect(extractZipEntryText(zipPath, entryName)).resolves.toBe(
        invalid ? null : "original archive",
      );
    },
  );
});

it("keeps the acquired archive bytes and notice together through a concurrent refresh", async () => {
  vi.resetModules();
  const archive = (version: string) =>
    zipSync(
      Object.fromEntries(
        ["11", "22", "33"].map((operator) => [
          `2025-02-03/operator-${operator}.json`,
          strToU8(JSON.stringify({ dataSource: version, trains: [] })),
        ]),
      ),
    );
  let downloadedArchive = archive("A");
  const refreshedArchive = archive("B");
  vi.stubGlobal("fetch", async () => new Response(downloadedArchive));
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const state = memoryCache();
  const sourceId = "opentransportdata-ch-occupancy-forecast";
  const a = { sourceId, name: "Archive A", notes: "Notice A" };
  const datasets = createSwissDatasets({
    http: testHttp(),
    cache: state.cache,
    contributors: { [sourceId]: [a] },
  });
  expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "11")).toMatchObject({
    dataSource: "A",
    contributors: [a],
  });
  const reached = new Promise<void>((resolve) => {
    archiveBarrier.reached = resolve;
  });
  let release!: () => void;
  archiveBarrier.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  archiveBarrier.hold = true;
  const retainedReader = datasets.loadSwissOccupancyForecastDataset("2025-02-03", "22");
  await reached;
  try {
    now += 6 * 60 * 60 * 1000 + 1;
    downloadedArchive = refreshedArchive;
    const b = { sourceId, name: "Archive B", notes: "Notice B" };
    const replacement = createSwissDatasets({
      http: testHttp(),
      cache: memoryCache().cache,
      contributors: { [sourceId]: [b] },
    });
    expect(await replacement.loadSwissOccupancyForecastDataset("2025-02-03", "33")).toMatchObject({
      dataSource: "B",
      contributors: [b],
    });
    await replacement.dispose();
    expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "33")).toMatchObject({
      dataSource: "B",
      contributors: [a],
    });
  } finally {
    release();
  }
  expect(await retainedReader).toMatchObject({ dataSource: "A", contributors: [a] });
  expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "22")).toMatchObject({
    dataSource: "B",
    contributors: [a],
  });
  await datasets.dispose();
});

it("preserves the successful business feed without caching a failed partial acquisition", async () => {
  const realtime = "sboid;abbreviationEn;complete\nch:1:sboid:1;SBB;YES";
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("go-siri-sx")) throw new Error("Feed unavailable");
    return new Response(realtime, { headers: { "content-type": "text/csv" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const datasets = createSwissDatasets({
    http: testHttp(),
    cache: memoryCache().cache,
    contributors: {},
  });
  expect((await datasets.loadSwissBusinessOrganisationDatasets()).entries).toMatchObject([
    { abbreviation: "SBB", hasRealtimeData: true },
  ]);
  expect((await datasets.loadSwissBusinessOrganisationDatasets()).entries).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  await datasets.dispose();
});

it("applies changed source policy before using a cached combined business dataset", async () => {
  let realtimeAllowed = true;
  const fetchMock = vi.fn(
    async (url: string) =>
      new Response(
        url.includes("go-realtime")
          ? "sboid;abbreviationEn;complete\nch:1:sboid:1;REAL;YES"
          : "sboid;abbreviationEn;participantRef\nch:1:sboid:2;SIRI;2",
        { headers: { "content-type": "text/csv" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const datasets = createSwissDatasets({
    http: testHttp(),
    cache: memoryCache().cache,
    contributors: {},
    isSourceAllowed: async (id) => id !== "opentransportdata-ch-go-realtime" || realtimeAllowed,
  });
  expect((await datasets.loadSwissBusinessOrganisationDatasets()).entries).toHaveLength(2);
  realtimeAllowed = false;
  expect((await datasets.loadSwissBusinessOrganisationDatasets()).entries).toMatchObject([
    { abbreviation: "SIRI" },
  ]);
  expect(fetchMock.mock.calls.filter(([url]) => url.includes("go-realtime"))).toHaveLength(1);
  await datasets.dispose();
});

it("bypasses local occupancy caches while unavailable and cleans temporary archives", async () => {
  const zip = zipSync({ "2025-02-03/operator-123.json": strToU8('{"dataSource":"fresh"}') });
  const fetchMock = vi.fn(async () => new Response(zip));
  vi.stubGlobal("fetch", fetchMock);
  const state = memoryCache();
  const datasets = createSwissDatasets({ http: testHttp(), cache: state.cache, contributors: {} });
  state.invalidate(false);
  expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123")).toMatchObject({
    dataSource: "fresh",
  });
  expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123")).toMatchObject({
    dataSource: "fresh",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const directory of archiveBarrier.createdDirectories)
    await expect(access(directory)).rejects.toThrow();
  state.invalidate(true);
  await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123");
  await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await datasets.dispose();
  for (const directory of archiveBarrier.createdDirectories)
    await expect(access(directory)).rejects.toThrow();
});

it("removes an invalidated archive that finishes downloading late", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  vi.stubGlobal("fetch", async () => new Response(body));
  const state = memoryCache();
  const datasets = createSwissDatasets({ http: testHttp(), cache: state.cache, contributors: {} });
  const created = new Promise<void>((resolve) => {
    archiveBarrier.created = resolve;
  });
  const pending = datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123");
  await created;
  state.invalidate();
  controller.enqueue(zipSync({ "2025-02-03/operator-123.json": strToU8('{"dataSource":"old"}') }));
  controller.close();
  expect(await pending).toBeNull();
  for (const directory of archiveBarrier.createdDirectories)
    await expect(access(directory)).rejects.toThrow();
  await datasets.dispose();
});

it("rejects discovered links outside the declared Swiss download hosts", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith(".zip"))
      return new Response(zipSync({ "fixture.csv": strToU8("sloid;wgs84North;wgs84East") }));
    if (url.endsWith(".csv")) return new Response("sloid;wgs84North;wgs84East");
    return new Response(
      '<a href="https://untrusted.example/download/actual-date.csv.zip">ZIP</a><a href="https://untrusted.example/download/actual-date.csv">CSV</a>',
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const datasets = createSwissDatasets({
    http: testHttp(),
    cache: memoryCache().cache,
    contributors: {},
  });
  expect((await datasets.loadSwissStopDatasets()).servicePoints).toEqual([]);
  expect(
    fetchMock.mock.calls.every(([url]) => new URL(url).hostname === "data.opentransportdata.swiss"),
  ).toBe(true);
  await datasets.dispose();
});

it("checks occupancy source policy before using an already cached archive", async () => {
  let allowed = true;
  const fetchMock = vi.fn(
    async () =>
      new Response(
        zipSync({
          "2025-02-03/operator-123.json": strToU8('{"dataSource":"cached"}'),
        }),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const datasets = createSwissDatasets({
    http: testHttp(),
    cache: memoryCache().cache,
    contributors: {},
    isSourceAllowed: async () => allowed,
  });
  expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123")).toMatchObject({
    dataSource: "cached",
  });
  allowed = false;
  expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await datasets.dispose();
});

it("disposal aborts a pending archive body and removes its temporary directory", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal("fetch", async () => new Response(body));
  const datasets = createSwissDatasets({
    http: testHttp(),
    cache: memoryCache().cache,
    contributors: {},
  });
  const created = new Promise<void>((resolve) => {
    archiveBarrier.created = resolve;
  });
  const pending = datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123");
  await created;
  await datasets.dispose();
  expect(await pending).toBeNull();
  expect(cancel).toHaveBeenCalledTimes(1);
  for (const directory of archiveBarrier.createdDirectories)
    await expect(access(directory)).rejects.toThrow();
  await expect(datasets.loadSwissOccupancyForecastDataset("2025-02-03", "123")).rejects.toThrow(
    "Swiss datasets disposed",
  );
});
