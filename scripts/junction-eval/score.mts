import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FrameOutput, type ReferenceFrame, scoreFrames, validateCorpus } from "./oracle.ts";

const args = process.argv.slice(2);
const value = (key: string, fallback: string) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const manifest = resolve(
  repo,
  value("--manifest", fileURLToPath(new URL("./fixtures/audit-manifest.json", import.meta.url))),
);
const split = value("--split", "holdout");
const output = resolve(
  repo,
  value("--outputs", fileURLToPath(new URL("./results/outputs.json", import.meta.url))),
);
const corpus = JSON.parse(readFileSync(manifest, "utf8")) as ReferenceFrame[];
const frames = corpus.filter((f) => f.split === split);
const outputs = JSON.parse(readFileSync(output, "utf8")) as FrameOutput[];
const result = scoreFrames(frames, outputs);
const negatives = frames.filter((f) => f.truth?.certainty === "certain" && !f.truth.photoRelevant);
const errors = validateCorpus(corpus);
const gates = {
  validCorpus: errors.length === 0,
  sites: new Set(frames.map((f) => f.site)).size >= 40,
  positiveSites:
    new Set(frames.filter((f) => f.truth?.clearMarkedSupported).map((f) => f.site)).size >= 20,
  negativeSites: new Set(negatives.map((f) => f.site)).size >= 10,
  completeTruth: frames.length > 0 && result.unscorable === 0 && result.missing === 0,
  correct:
    frames.length > 0 &&
    result.unscorable === 0 &&
    result.missing === 0 &&
    result.wrongLane === 0 &&
    result.wrongScene === 0,
  useful: result.usefulness >= 0.7,
};
console.log(JSON.stringify({ split, ...result, gates, errors }, null, 2));
if (!args.includes("--report-only") && Object.values(gates).some((passed) => !passed))
  process.exitCode = 1;
