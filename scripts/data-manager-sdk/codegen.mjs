import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "orval";
import { formatSource } from "../codegen/format-source.mjs";
import { createCodegenConfig, operationBindings, operationIds } from "./config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const generatedDirectory = join(root, "packages/core/src/services/data-manager/generated");

async function listFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? listFiles(path) : [path];
        }),
      )
    )
      .flat()
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

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
    const target = join(directory, "generated");
    const files = await listFiles(target);
    if (!files.includes(join(target, "data-manager.generated.ts")))
      throw new Error("Orval did not generate the data-manager SDK; check the OpenAPI document.");
    return await Promise.all(
      files.map(async (path) => ({
        filename: relative(target, path),
        content: formatSource(
          join(generatedDirectory, relative(target, path)),
          await readFile(path, "utf8"),
        ),
      })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function writeOrCheckArtifacts(
  files,
  { check = false, outputDirectory = generatedDirectory } = {},
) {
  const expected = new Map(files.map((file) => [file.filename, file.content]));
  const stale = [];
  for (const [filename, content] of expected) {
    try {
      if ((await readFile(join(outputDirectory, filename), "utf8")) !== content)
        stale.push(`${filename} (stale)`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      stale.push(`${filename} (missing)`);
    }
  }
  for (const path of await listFiles(outputDirectory)) {
    if (!expected.has(relative(outputDirectory, path)))
      stale.push(`${relative(outputDirectory, path)} (extra)`);
  }
  if (check) {
    if (stale.length)
      throw new Error(
        `Generated data-manager SDK differs:\n${stale.join("\n")}\nRun pnpm data-manager:sdk:generate.`,
      );
    return;
  }
  await rm(outputDirectory, { recursive: true, force: true });
  for (const [filename, content] of expected) {
    await mkdir(dirname(join(outputDirectory, filename)), { recursive: true });
    await writeFile(join(outputDirectory, filename), content);
  }
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
