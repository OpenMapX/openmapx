import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mobidromParkingEquivalenceContract } from "./mobidrom-equivalence-helpers.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = {
  idPrefix: "de-goldbeck",
  sourceId: "de-goldbeck",
  operatorName: "GOLDBECK Parking Services GmbH",
} as const;

mobidromParkingEquivalenceContract("GOLDBECK", FIXTURE, OPTS);
