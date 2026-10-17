import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as prettier from "prettier";

const require = createRequire(import.meta.url);
const biome = require.resolve("@biomejs/biome/bin/biome");
const paths = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

let failed = false;
const code = [];
for (const path of paths) {
  const text = /\.(md|ya?ml)$/.test(path);
  if (!text && !/\.([cm]?[jt]sx?|jsonc?|css|graphql|gql)$/.test(path)) continue;
  // Symlinks store a target path in the index, not source text to format.
  const entry = execFileSync("git", ["ls-files", "--stage", "-z", "--", path], {
    encoding: "utf8",
  });
  if (entry.startsWith("120000 ")) continue;
  const filepath = resolve(path);
  if (text && (await prettier.getFileInfo(filepath, { ignorePath: ".prettierignore" })).ignored)
    continue;
  // Read the index without stashing, formatting or rewriting working files.
  const content = execFileSync("git", ["show", `:0:${path}`], { maxBuffer: 32 * 1024 * 1024 });
  if (text) {
    try {
      const options = await prettier.resolveConfig(filepath, { editorconfig: true });
      if (!(await prettier.check(content.toString("utf8"), { ...options, filepath }))) {
        console.error(`${JSON.stringify(path)}: staged content needs Prettier formatting.`);
        failed = true;
      }
    } catch (error) {
      console.error(`${JSON.stringify(path)}: ${error.message}`);
      failed = true;
    }
  } else {
    code.push({ path, content });
  }
}
if (code.length) {
  const snapshot = mkdtempSync(join(tmpdir(), "openmapx-staged-"));
  try {
    for (const config of ["biome.json", "turbo.json", "package.json"]) {
      if (existsSync(config)) copyFileSync(config, join(snapshot, config));
    }
    for (const { path, content } of code) {
      const destination = join(snapshot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    // Biome's file mode reports parse/lint errors reliably. The snapshot keeps
    // both the index and working tree intact, including partially staged files.
    const result = spawnSync(
      process.execPath,
      [
        biome,
        "check",
        "--vcs-enabled=false",
        "--no-errors-on-unmatched",
        ...code.map(({ path }) => `./${path}`),
      ],
      { cwd: snapshot, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) failed = true;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}
if (failed) process.exitCode = 1;
