import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert,
  productVersionPattern,
  readProductReleaseConfig,
} from "./product-release-config.mjs";
export function prepareReleaseRecord(root, version, fragments = []) {
  assert(productVersionPattern.test(version), "Use an unprefixed alpha/beta/rc version");
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/tags/v${version}`], {
      cwd: root,
      stdio: "ignore",
    });
    throw new Error("Version tag already exists; choose a new version");
  } catch (error) {
    if (error.status === undefined) throw error;
  }
  const remote = execFileSync(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/v${version}`, `refs/tags/v${version}^{}`],
    { cwd: root, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  assert(remote.trim() === "", "Version already exists on origin; choose a new version");
  const path = resolve(root, "scripts/product-release.json");
  const current = readProductReleaseConfig(readFileSync(path, "utf8"));
  const next = { ...current, version, notesPath: `docs/docs/releases/${version}.md` };
  const notesPath = resolve(root, next.notesPath);
  const entries = fragments.map((fragment) => {
    assert(
      /^release-notes\/[a-z0-9][a-z0-9-]*\.md$/.test(fragment) &&
        fragment !== "release-notes/README.md",
      "Choose explicit release-note fragments",
    );
    return readFileSync(resolve(root, fragment), "utf8")
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .trim();
  });
  mkdirSync(dirname(notesPath), { recursive: true });
  if (!existsSync(notesPath))
    writeFileSync(
      notesPath,
      `---\ntitle: ${version} preparation\n---\n\nIntended prerelease; not published.\n\n## Changes and operator actions\n\n${entries.join("\n\n") || "Curate the changes and required operator actions before selecting a candidate."}\n\n## Compatibility and limitations\n\nExperimental linux/amd64 images; extension protocol 1.0. Package and mobile versions are independent.\n\n## Installation, upgrade and recovery\n\nRehearse the declared upgrade origins with the exact candidate. Image rollback does not undo database migrations. Record real checks and recovery limits before publication.\n`,
    );
  else
    assert(
      entries.length === 0,
      "Notes already exist; incorporate selected fragments deliberately without duplicating them",
    );
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, version, ...fragments] = process.argv.slice(2);
  assert(
    flag === "--version",
    "Usage: node scripts/prepare-product-release.mjs --version 0.1.0-alpha.2 [release-notes/fragment.md ...]",
  );
  prepareReleaseRecord(process.cwd(), version, fragments);
}
