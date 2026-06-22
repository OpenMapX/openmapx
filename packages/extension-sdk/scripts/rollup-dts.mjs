/**
 * Declaration rollup via @microsoft/api-extractor.
 *
 * Runs tsc --emitDeclarationOnly into a temp dir, then invokes api-extractor
 * once per entry point (index, testing) to produce self-contained .d.ts
 * rollups in dist/. Workspace package types (@openmapx/*) are inlined so
 * consumers need no @openmapx/* devDependencies.
 *
 * Finally, copies each rolled-up .d.ts to a matching .d.cts so CJS consumers
 * get proper type declarations alongside dist/*.cjs.
 */
import { spawnSync } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(__dirname, "..");

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: pkg, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const tsc = resolve(pkg, "node_modules/.bin/tsc");
const apiExtractor = resolve(pkg, "node_modules/.bin/api-extractor");
const dist = resolve(pkg, "dist");
const distTemp = resolve(pkg, "dist-temp");

console.log("emitting raw declarations via tsc...");
run(tsc, ["-p", "tsconfig.dts.json", "--noEmit", "false"]);

console.log("rolling up index.d.ts via api-extractor...");
run(apiExtractor, ["run", "--config", "api-extractor.index.json", "--local"]);

console.log("rolling up testing.d.ts via api-extractor...");
run(apiExtractor, ["run", "--config", "api-extractor.testing.json", "--local"]);

console.log("copying .d.ts → .d.cts for CJS consumers...");
const entries = ["index", "testing"];
await Promise.all(entries.map((name) => copyFile(`${dist}/${name}.d.ts`, `${dist}/${name}.d.cts`)));

console.log("cleaning up dist-temp...");
await rm(distTemp, { recursive: true, force: true });

console.log("declaration rollup complete:", entries.map((e) => `${e}.d.ts/.d.cts`).join(", "));
