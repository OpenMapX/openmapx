import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  assertFacilitiesEqual,
  migratedRunAll,
  refRunAll,
} from "./mobidrom-equivalence-helpers.js";

// Fixture publicationTime is 2026-05-23T10:00:00Z; anchor wall-clock 10 min
// later so the shared isLiveTooStale gate (30 min) keeps hasRealtimeData=true.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-23T10:10:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = {
  idPrefix: "de-apag",
  sourceId: "de-apag",
  operatorName: "APAG - Aachener Parkhaus GmbH",
} as const;

describe("apag parser+mapper equivalence to pre-migration impl", () => {
  it("produces field-by-field-identical facilities including operator carry-through", async () => {
    const ref = refRunAll(FIXTURE, OPTS);
    const got = await migratedRunAll(FIXTURE, OPTS);
    assertFacilitiesEqual(got, ref);
  });
});
