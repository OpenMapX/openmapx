import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ReferenceFrame, validateCorpus } from "./oracle.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const path = resolve(
  repo,
  process.argv[2] ?? fileURLToPath(new URL("./fixtures/audit-manifest.json", import.meta.url)),
);
const frames = JSON.parse(readFileSync(path, "utf8")) as ReferenceFrame[];
const errors = validateCorpus(frames);
console.log(
  JSON.stringify(
    {
      frames: frames.length,
      sites: new Set(frames.map((f) => f.site)).size,
      regions: new Set(frames.map((f) => f.region)).size,
      sources: Object.fromEntries(
        [...new Set(frames.map((f) => f.source))].map((source) => [
          source,
          frames.filter((f) => f.source === source).length,
        ]),
      ),
      annotated: frames.filter((f) => f.truth).length,
      errors,
    },
    null,
    2,
  ),
);
if (errors.length) process.exitCode = 1;
