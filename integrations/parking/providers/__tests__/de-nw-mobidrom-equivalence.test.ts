import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mobidromParkingEquivalenceContract } from "./mobidrom-equivalence-helpers.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "mobidrom-sample.json"));
const OPTS = { idPrefix: "nrw", sourceId: "de-nw-mobidrom" } as const;

mobidromParkingEquivalenceContract("NRW Mobidrom aggregate", FIXTURE, OPTS);
