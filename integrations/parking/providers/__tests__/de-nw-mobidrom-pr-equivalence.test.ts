import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mobidromParkingEquivalenceContract } from "./mobidrom-equivalence-helpers.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = {
  idPrefix: "nrw-pr",
  sourceId: "de-nw-mobidrom-pr",
  forceParkAndRide: true,
} as const;

mobidromParkingEquivalenceContract("NRW Mobidrom park and ride", FIXTURE, OPTS);
