import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  assertFacilitiesEqual,
  migratedRunAll,
  refRunAll,
} from "./mobidrom-equivalence-helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-23T10:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = { idPrefix: "nrw", sourceId: "nrw-mobidrom-parking" } as const;

describe("nrw-mobidrom (aggregate) parser+mapper equivalence to pre-migration impl", () => {
  it("produces field-by-field-identical facilities for every record", async () => {
    const ref = refRunAll(FIXTURE, OPTS);
    const got = await migratedRunAll(FIXTURE, OPTS);
    assertFacilitiesEqual(got, ref);
  });
});
