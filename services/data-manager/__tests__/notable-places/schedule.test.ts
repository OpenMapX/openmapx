import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { fameFromSitelinks } from "../../src/jobs/notable-places/build.js";
import {
  notablePlacesSettings,
  scheduleNotablePlaces,
} from "../../src/jobs/notable-places/schedule.js";
import { createNotablePlacesRuntimeState } from "../../src/jobs/notable-places/state.js";
import type { SearchIndexOperationLock } from "../../src/jobs/search-index/operation-lock.js";

function fakeSql(published: boolean): postgres.Sql {
  return { unsafe: vi.fn(async () => [{ exists: published }]) } as unknown as postgres.Sql;
}

const lock: SearchIndexOperationLock = {
  inFlight: false,
  run: (operation) => operation(),
};
const logger = { info: vi.fn(), warn: vi.fn() };

describe("notable-places fame", () => {
  it("rises with the Wikipedias covering a place, on a log scale", () => {
    expect(fameFromSitelinks(0)).toBe(0);
    expect(fameFromSitelinks(8)).toBeCloseTo(0.3, 5);
    expect(fameFromSitelinks(40)).toBeCloseTo(0.6, 1);
    expect(fameFromSitelinks(191)).toBeGreaterThan(0.9);
    expect(fameFromSitelinks(5_000)).toBe(1);
    // Below the index's threshold a place is no destination from afar.
    expect(fameFromSitelinks(3)).toBeLessThan(0.3);
  });
});

describe("notable-places settings", () => {
  it("reads the endpoint and threshold, falling back to defaults", () => {
    expect(notablePlacesSettings({})).toEqual({ endpoint: undefined, minSitelinks: 8 });
    expect(
      notablePlacesSettings({
        NOTABLE_PLACES_SPARQL_URL: " https://qlever.example/wikidata ",
        NOTABLE_PLACES_MIN_SITELINKS: "12",
      }),
    ).toEqual({ endpoint: "https://qlever.example/wikidata", minSitelinks: 12 });
    expect(notablePlacesSettings({ NOTABLE_PLACES_MIN_SITELINKS: "0" }).minSitelinks).toBe(8);
  });
});

describe("notable-places schedule", () => {
  it("builds once at startup when nothing is published", async () => {
    const build = vi.fn(async () => ({
      epoch: "e",
      source: "s",
      minSitelinks: 8,
      placeCount: 2,
      nameCount: 3,
    }));
    const schedule = scheduleNotablePlaces({
      sql: fakeSql(false),
      runtimeState: createNotablePlacesRuntimeState(),
      operationLock: lock,
      logger,
      cronExpression: "0 2 1 * *",
      build,
    });
    await schedule.buildIfMissing();
    schedule.stop();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("leaves a published snapshot to the monthly refresh", async () => {
    const build = vi.fn();
    const schedule = scheduleNotablePlaces({
      sql: fakeSql(true),
      runtimeState: createNotablePlacesRuntimeState(),
      operationLock: lock,
      logger,
      cronExpression: "0 2 1 * *",
      build,
    });
    await schedule.buildIfMissing();
    schedule.stop();
    expect(build).not.toHaveBeenCalled();
  });

  it("fetches nothing when the operator turned the refresh off", async () => {
    const build = vi.fn();
    const schedule = scheduleNotablePlaces({
      sql: fakeSql(false),
      runtimeState: createNotablePlacesRuntimeState(),
      operationLock: lock,
      logger,
      cronExpression: "off",
      build,
    });
    await schedule.buildIfMissing();
    schedule.stop();
    expect(build).not.toHaveBeenCalled();
  });

  it("logs a failed build instead of throwing, keeping the old snapshot", async () => {
    const build = vi.fn(async () => {
      throw new Error("endpoint down");
    });
    const warn = vi.fn();
    const schedule = scheduleNotablePlaces({
      sql: fakeSql(false),
      runtimeState: createNotablePlacesRuntimeState(),
      operationLock: lock,
      logger: { info: vi.fn(), warn },
      cronExpression: "0 2 1 * *",
      build,
    });
    await expect(schedule.buildIfMissing()).resolves.toBeUndefined();
    schedule.stop();
    expect(warn).toHaveBeenCalledWith({ err: "endpoint down" }, "notable-places: build failed");
  });
});
