import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "orval";
import { collectArtifacts, writeOrCheckArtifacts as writeOrCheck } from "../codegen/artifacts.mjs";
import { createCodegenConfig } from "./codegen.config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageDirectory = join(root, "integrations/transit-mbta");
const generatedDirectory = join(packageDirectory, "generated");
export async function generateArtifacts({
  document,
  inputPath = join(packageDirectory, "schema/swagger.json"),
} = {}) {
  let inputDocument = document;
  if (!inputDocument) {
    const snapshot = await readFile(inputPath);
    if (
      createHash("sha256").update(snapshot).digest("hex") !==
      "16fd4783e1862ac5f1433b8d98b8d06a6599d0c9a3962f0aa5941538bca33906"
    )
      throw new Error(
        "MBTA snapshot SHA-256 differs; review the contract and update its provenance deliberately.",
      );
    inputDocument = JSON.parse(snapshot.toString("utf8"));
  }
  const scratchRoot = join(root, ".superpowers/mbta");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "generation-"));
  try {
    await cp(join(packageDirectory, "transport.ts"), join(directory, "transport.ts"));
    await generate(createCodegenConfig({ inputDocument, outputDirectory: directory }));
    return await collectArtifacts(join(directory, "generated"), generatedDirectory, [
      "client.ts",
      "models/predictions.zod.ts",
      "models/stop.zod.ts",
      "models/stops.zod.ts",
      "models/vehicles.zod.ts",
      "models/alerts.zod.ts",
      "models/facilities.zod.ts",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export function writeOrCheckArtifacts(files, options = {}) {
  return writeOrCheck(files, {
    outputDirectory: generatedDirectory,
    label: "MBTA SDK",
    regenerateCommand: "pnpm mbta:generate",
    ...options,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--check"))
      throw new Error("Usage: node scripts/mbta/codegen.mjs [--check]");
    await writeOrCheckArtifacts(await generateArtifacts(), {
      check: process.argv.includes("--check"),
    });
    console.log("✓ MBTA SDK is current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
