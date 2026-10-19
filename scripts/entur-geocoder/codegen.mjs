import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "orval";
import { collectArtifacts, writeOrCheckArtifacts as writeOrCheck } from "../codegen/artifacts.mjs";
import { createCodegenConfig } from "./codegen.config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageDirectory = join(root, "packages/entur-client");
const generatedDirectory = join(packageDirectory, "src/geocoder/generated");
export async function generateArtifacts({
  document,
  inputPath = join(packageDirectory, "schema/geocoder.openapi.json"),
} = {}) {
  let inputDocument = document;
  if (!inputDocument) {
    const snapshot = await readFile(inputPath);
    if (
      createHash("sha256").update(snapshot).digest("hex") !==
      "499b75814a4c391bd640e977a724cb7398a71f31fd60cac39bdc864d916ff978"
    )
      throw new Error(
        "Entur Geocoder snapshot SHA-256 differs; review the contract and update its provenance deliberately.",
      );
    inputDocument = JSON.parse(snapshot.toString("utf8"));
  }
  const scratchRoot = join(root, ".superpowers/entur-geocoder");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "generation-"));
  try {
    await cp(join(packageDirectory, "src/geocoder/transport.ts"), join(directory, "transport.ts"));
    await generate(createCodegenConfig({ inputDocument, outputDirectory: directory }));
    return await collectArtifacts(join(directory, "generated"), generatedDirectory, [
      "client.ts",
      "models/result.zod.ts",
      "models/autocompleteParams.zod.ts",
      "models/reverseParams.zod.ts",
      "models/placeParams.zod.ts",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export function writeOrCheckArtifacts(files, options = {}) {
  return writeOrCheck(files, {
    outputDirectory: generatedDirectory,
    label: "Entur Geocoder SDK",
    regenerateCommand: "pnpm entur-geocoder:generate",
    ...options,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--check"))
      throw new Error("Usage: node scripts/entur-geocoder/codegen.mjs [--check]");
    await writeOrCheckArtifacts(await generateArtifacts(), {
      check: process.argv.includes("--check"),
    });
    console.log("✓ Entur Geocoder SDK is current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
