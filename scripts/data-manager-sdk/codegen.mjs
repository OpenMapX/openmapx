import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "orval";
import { collectArtifacts, writeOrCheckArtifacts as writeOrCheck } from "../codegen/artifacts.mjs";
import { createCodegenConfig, operationBindings, operationIds } from "./config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const generatedDirectory = join(root, "packages/core/src/services/data-manager/generated");

export async function generateArtifacts({
  document,
  inputPath = join(root, "services/data-manager/openapi.json"),
} = {}) {
  const inputDocument = document ?? JSON.parse(await readFile(inputPath, "utf8"));
  const scratchRoot = join(root, ".superpowers/data-manager-sdk");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "generation-"));
  try {
    await cp(
      join(root, "packages/core/src/services/data-manager/transport.ts"),
      join(directory, "transport.ts"),
    );
    await mkdir(join(directory, "generated"), { recursive: true });
    await writeFile(
      join(directory, "generated/operation-bindings.generated.ts"),
      operationBindings(operationIds(inputDocument)),
    );
    await generate(createCodegenConfig({ inputDocument, outputDirectory: directory }));
    return await collectArtifacts(join(directory, "generated"), generatedDirectory, [
      "data-manager.generated.ts",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function writeOrCheckArtifacts(files, options = {}) {
  return writeOrCheck(files, {
    outputDirectory: generatedDirectory,
    label: "data-manager SDK",
    regenerateCommand: "pnpm data-manager:sdk:generate",
    ...options,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--check"))
      throw new Error("Usage: node scripts/data-manager-sdk/codegen.mjs [--check]");
    await writeOrCheckArtifacts(await generateArtifacts(), {
      check: process.argv.includes("--check"),
    });
    console.log("✓ Data-manager SDK is current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
