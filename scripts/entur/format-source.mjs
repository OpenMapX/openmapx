import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
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
