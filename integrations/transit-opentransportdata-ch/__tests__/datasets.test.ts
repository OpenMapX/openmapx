import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractZipEntryText, loadSwissOccupancyForecastDataset } from "../datasets.js";

const archiveBarrier = vi.hoisted(() => ({
  hold: false,
  reached: undefined as undefined | (() => void),
  release: undefined as undefined | Promise<void>,
  replace: undefined as undefined | (() => Promise<void>),
  closeError: false,
}));
vi.mock("node:fs/promises", async (load) => {
  const original = await load<typeof import("node:fs/promises")>();
  return {
    ...original,
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

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  archiveBarrier.hold = false;
  archiveBarrier.replace = undefined;
  archiveBarrier.closeError = false;
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

    await expect(loadSwissOccupancyForecastDataset(opDate, operatorRef)).resolves.toBeNull();
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
  const datasets = await import("../datasets.js");
  const sourceId = "opentransportdata-ch-occupancy-forecast";
  const a = { sourceId, name: "Archive A", notes: "Notice A" };
  datasets.setSwissDatasetContributors({ [sourceId]: [a] });
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
    datasets.setSwissDatasetContributors({ [sourceId]: [b] });
    expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "33")).toMatchObject({
      dataSource: "B",
      contributors: [b],
    });
  } finally {
    release();
  }
  expect(await retainedReader).toMatchObject({ dataSource: "A", contributors: [a] });
  expect(await datasets.loadSwissOccupancyForecastDataset("2025-02-03", "22")).toMatchObject({
    dataSource: "A",
    contributors: [a],
  });
});
