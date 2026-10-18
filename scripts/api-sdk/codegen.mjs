import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "orval";
import { formatSource } from "../codegen/format-source.mjs";
import { createCodegenConfig } from "./config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const generatedDirectory = join(root, "packages/core/src/api/generated");

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

export async function generateArtifacts({ inputPath = join(root, "apps/api/openapi.json") } = {}) {
  const document = JSON.parse(await readFile(inputPath, "utf8"));
  // Validate only the family being adopted. Unrelated inventory-only routes
  // still have incomplete payload/parameter contracts and are not SDK input.
  const paths = {};
  for (const [path, item] of Object.entries(document.paths)) {
    const operations = Object.fromEntries(
      Object.entries(item).filter(([, operation]) => operation?.tags?.includes("runtime-metadata")),
    );
    if (Object.keys(operations).length)
      paths[path] = {
        ...(item.parameters ? { parameters: item.parameters } : {}),
        ...operations,
      };
  }
  const inputDocument = { ...document, paths };
  // Keep generator input beside a copy of the real mutator so all output
  // imports are identical to the committed layout. --check never writes there.
  const scratchRoot = join(root, ".superpowers/api-sdk");
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, "generation-"));
  try {
    for (const name of ["sdk-transport.ts", "client.ts"]) {
      await cp(join(root, "packages/core/src/api", name), join(directory, name));
    }
    await generate(
      createCodegenConfig({ inputDocument, outputDirectory: directory }).runtimeMetadata,
    );
    const target = join(directory, "generated");
    const files = await listFiles(target);
    if (!files.length) throw new Error("No runtime metadata SDK artifacts generated.");
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
      throw new Error(`Generated API SDK differs:\n${stale.join("\n")}\nRun pnpm sdk:generate.`);
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
      throw new Error("Usage: node scripts/api-sdk/codegen.mjs [--check]");
    await writeOrCheckArtifacts(await generateArtifacts(), {
      check: process.argv.includes("--check"),
    });
    console.log("✓ Runtime metadata SDK is current.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
