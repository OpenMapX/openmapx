import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const cwd = fileURLToPath(new URL("../../", import.meta.url));

/** Apply the same formatter and import organization as repository checks. */
export function formatSource(filename, content) {
  return execFileSync(
    process.execPath,
    [biome, "check", "--write", "--linter-enabled=false", "--stdin-file-path", filename],
    { cwd, input: content, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
}

/** Format only collected files in an Orval-owned generation scratch directory. */
export function formatSourceFiles(sourceDirectory, paths) {
  const directory = realpathSync(sourceDirectory);
  if (
    directory !== resolve(sourceDirectory) ||
    !/^\.superpowers\/(api-sdk|data-manager-sdk|entur-geocoder)\/generation-[^/]+\/generated$/.test(
      relative(cwd, directory).split(sep).join("/"),
    )
  )
    throw new Error("Batch formatting requires generator-owned scratch.");

  // Stdin formatting had no on-disk size limit. Include the largest artifact
  // rather than letting Biome silently skip files above its default one MiB.
  let maxSize = 1024 * 1024;
  for (const path of paths) {
    if (!resolve(path).startsWith(`${directory}${sep}`) || realpathSync(path) !== resolve(path))
      throw new Error(`Artifact is outside owned scratch or is a symbolic link: ${path}`);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
    // Biome 2.5.15 excludes files whose size equals the configured limit too.
    maxSize = Math.max(maxSize, stat.size + 1);
  }
  if (!paths.length) return;

  const { summary } = JSON.parse(
    execFileSync(
      process.execPath,
      [
        biome,
        "check",
        "--write",
        "--linter-enabled=false",
        "--vcs-enabled=false",
        "--files-ignore-unknown=false",
        `--files-max-size=${maxSize}`,
        "--error-on-warnings",
        "--reporter=json",
        ...paths,
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 90_000,
        killSignal: "SIGKILL",
      },
    ),
  );
  // The pinned CLI's summary accounts for every file, including already clean
  // ones. A successful exit alone can conceal config-excluded/unsupported files.
  if (
    summary.errors !== 0 ||
    summary.warnings !== 0 ||
    summary.skipped !== 0 ||
    summary.changed + summary.unchanged !== paths.length
  )
    throw new Error(`Biome did not format all ${paths.length} generated artifacts.`);
}
