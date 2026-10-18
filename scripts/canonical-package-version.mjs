import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const cli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");

/** Replay trusted-base data with the installed CLI; never execute candidate scripts. */
export function canonicalPackageVersion({
  cwd,
  before,
  after,
  changed,
  packages,
  git,
  validatePending,
}) {
  const config = before.json(".changeset/config.json");
  if (
    config?.commit !== false ||
    config.format !== false ||
    config.changelog !== "@changesets/cli/changelog" ||
    (config.privatePackages !== false && config.privatePackages?.version !== false) ||
    before.entries.has(".changeset/pre.json")
  )
    throw new Error(
      "Canonical package version validation requires the qualified-package baseline (private versioning disabled, default changelog, format:false, no commit hook or prerelease mode)",
    );
  validatePending();
  const allowed = (path) =>
    packages.some(
      (item) =>
        path === `${item.directory}/package.json` ||
        path === `${item.directory}/CHANGELOG.md` ||
        (item.versionedSchemas &&
          path.startsWith(`${item.directory}/${item.versionedSchemas}/`) &&
          path.endsWith(".json")),
    ) || /^\.changeset\/[a-z0-9][a-z0-9-]*\.md$/.test(path);
  if (!changed.length || changed.some((path) => !allowed(path)))
    throw new Error(
      "Canonical version PR contains unexpected source, configuration or lockfile changes",
    );
  const temp = mkdtempSync(join(tmpdir(), "openmapx-canonical-version-"));
  const clone = join(temp, "source");
  try {
    git(cwd, "clone", "--quiet", "--shared", "--no-checkout", "--", cwd, clone);
    git(clone, "checkout", "--quiet", "--detach", before.ref);
    symlinkSync(
      resolve(import.meta.dirname, "../node_modules"),
      join(clone, "node_modules"),
      "dir",
    );
    const result = spawnSync(process.execPath, [cli, "version"], {
      cwd: clone,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true" },
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Canonical Changesets replay failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
      );
    for (const item of packages.filter((item) => item.versionedSchemas)) {
      const previous = before.json(`${item.directory}/package.json`).version;
      const next = JSON.parse(
        readFileSync(join(clone, item.directory, "package.json"), "utf8"),
      ).version;
      if (previous === next) continue;
      for (const path of before.entries.keys()) {
        if (
          !path.startsWith(`${item.directory}/${item.versionedSchemas}/`) ||
          !path.endsWith(".json")
        )
          continue;
        const schema = before.json(path);
        const suffix = `/${previous}/${basename(path)}`;
        if (typeof schema.$id !== "string" || !schema.$id.endsWith(suffix))
          throw new Error(`Canonical schema id does not match package version: ${path}`);
        schema.$id = `${schema.$id.slice(0, -suffix.length)}/${next}/${basename(path)}`;
        writeFileSync(join(clone, path), `${JSON.stringify(schema, null, 2)}\n`);
      }
    }
    const expected = [
      ...new Set(
        git(clone, "ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z")
          .toString()
          .split("\0")
          .filter((path) => path && path !== "node_modules"),
      ),
    ].sort();
    if (
      !expected.length ||
      expected.some((path) => !allowed(path)) ||
      JSON.stringify(expected) !== JSON.stringify([...changed].sort())
    )
      throw new Error(
        `Canonical version PR file set differs: expected ${JSON.stringify(expected)}, received ${JSON.stringify([...changed].sort())}`,
      );
    for (const path of expected) {
      const expectedBytes = existsSync(join(clone, path)) ? readFileSync(join(clone, path)) : null;
      const actual = after.read(path);
      if (
        expectedBytes === null ? actual !== null : actual === null || !expectedBytes.equals(actual)
      )
        throw new Error(`Canonical version PR differs from expected output: ${path}`);
    }
    return {
      errors: [],
      affected: packages
        .filter((item) => changed.includes(`${item.directory}/package.json`))
        .map((item) => item.name),
      reason: null,
      version: true,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
