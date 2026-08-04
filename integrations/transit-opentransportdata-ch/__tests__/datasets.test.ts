import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractZipEntryText, loadSwissOccupancyForecastDataset } from "../datasets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
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
});
