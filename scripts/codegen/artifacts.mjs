import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { formatSource } from "./format-source.mjs";

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

/** Read formatted artifacts without mutating the destination in check mode. */
export async function collectArtifacts(sourceDirectory, outputDirectory, requiredFiles) {
  const paths = await listFiles(sourceDirectory);
  for (const name of requiredFiles)
    if (!paths.includes(join(sourceDirectory, name)))
      throw new Error(`Orval did not generate ${name}; check the OpenAPI document.`);
  return Promise.all(
    paths.map(async (path) => ({
      filename: relative(sourceDirectory, path),
      content: formatSource(
        join(outputDirectory, relative(sourceDirectory, path)),
        await readFile(path, "utf8"),
      ),
    })),
  );
}
export async function writeOrCheckArtifacts(
  files,
  { check = false, outputDirectory, label = "SDK", regenerateCommand } = {},
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
        `Generated ${label} differs:\n${stale.join("\n")}\nRun ${regenerateCommand}.`,
      );
    return;
  }
  await rm(outputDirectory, { recursive: true, force: true });
  for (const [filename, content] of expected) {
    await mkdir(dirname(join(outputDirectory, filename)), { recursive: true });
    await writeFile(join(outputDirectory, filename), content);
  }
}
