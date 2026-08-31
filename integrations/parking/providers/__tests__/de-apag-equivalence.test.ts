import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mobidromParkingEquivalenceContract } from "./mobidrom-equivalence-helpers.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = {
  idPrefix: "de-apag",
  sourceId: "de-apag",
  operatorName: "APAG - Aachener Parkhaus GmbH",
} as const;

mobidromParkingEquivalenceContract("APAG", FIXTURE, OPTS);
