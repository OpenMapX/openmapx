import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mobidromParkingEquivalenceContract } from "./mobidrom-equivalence-helpers.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = {
  idPrefix: "de-apcoa",
  sourceId: "de-apcoa",
  operatorName: "APCOA Deutschland GmbH",
} as const;

mobidromParkingEquivalenceContract("APCOA", FIXTURE, OPTS);
