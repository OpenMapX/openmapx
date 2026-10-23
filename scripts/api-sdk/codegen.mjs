import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "orval";
import { collectArtifacts, writeOrCheckArtifacts as writeOrCheck } from "../codegen/artifacts.mjs";
import {
  adminOperationBindings,
  createCodegenConfig,
  savedOperationBindings,
  selectTaggedDocument,
} from "./config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const generatedDirectory = join(root, "packages/core/src/api/generated");

export async function generateArtifacts({
  document,
  inputPath = join(root, "apps/api/openapi.json"),
} = {}) {
  const inputDocument = document ?? JSON.parse(await readFile(inputPath, "utf8"));
  const scratchRoot = join(root, ".superpowers/api-sdk");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "generation-"));
  try {
    for (const name of [
      "sdk-transport.ts",
      "admin-sdk-transport.ts",
      "operation-transport.ts",
      "saved-sdk-transport.ts",
      "client.ts",
    ])
      await cp(join(root, "packages/core/src/api", name), join(directory, name));
    await mkdir(join(directory, "generated/admin"), { recursive: true });
    await writeFile(
      join(directory, "generated/admin/operation-bindings.generated.ts"),
      adminOperationBindings(inputDocument),
    );
    if (Object.keys(selectTaggedDocument(inputDocument, "saved-places").paths).length) {
      await mkdir(join(directory, "generated/saved"), { recursive: true });
      await writeFile(
        join(directory, "generated/saved/operation-bindings.generated.ts"),
        savedOperationBindings(inputDocument),
      );
    }
    const config = createCodegenConfig({ inputDocument, outputDirectory: directory });
    await generate(config.runtimeMetadata);
    for (const [family, configuration] of Object.entries(config))
      if (family !== "runtimeMetadata") await generate(configuration);
    return await collectArtifacts(join(directory, "generated"), generatedDirectory, [
      "runtime-metadata.generated.ts",
      ...Object.values(config)
        .filter((configuration) => configuration !== config.runtimeMetadata)
        .map((configuration) =>
          relative(join(directory, "generated"), configuration.output.target),
        ),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function writeOrCheckArtifacts(files, options = {}) {
  return writeOrCheck(files, {
    outputDirectory: generatedDirectory,
    label: "API SDK",
    regenerateCommand: "pnpm sdk:generate",
    ...options,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== "--check"))
      throw new Error("Usage: node scripts/api-sdk/codegen.mjs [--check]");
    await writeOrCheckArtifacts(await generateArtifacts(), {
      check: process.argv.includes("--check"),
    });
    console.log("✓ API SDK families are current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
