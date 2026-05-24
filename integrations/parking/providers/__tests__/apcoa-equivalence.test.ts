import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  assertFacilitiesEqual,
  migratedRunAll,
  refRunAll,
} from "./mobidrom-equivalence-helpers.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = {
  idPrefix: "apcoa",
  sourceId: "apcoa",
  operatorName: "APCOA Deutschland GmbH",
} as const;

describe("apcoa parser+mapper equivalence to pre-migration impl", () => {
  it("produces field-by-field-identical facilities for the APCOA feed", async () => {
    const ref = refRunAll(FIXTURE, OPTS);
    const got = await migratedRunAll(FIXTURE, OPTS);
    assertFacilitiesEqual(got, ref);
  });
});
