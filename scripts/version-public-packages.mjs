// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: manual Actions version preparation.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  generatePackageVersions,
  pendingVersionNotes,
  validateVersionBaseline,
  versionFileAllowed,
} from "./canonical-package-version.mjs";
import { contributionCheck, git, publicPackages, snapshot } from "./check-release-information.mjs";

export function pendingPublicPackages({ cwd }) {
  const state = snapshot(cwd, "HEAD");
  validateVersionBaseline(state);
  const packages = publicPackages(state);
  const pending = pendingVersionNotes(state);
  const validation = contributionCheck({ before: state, after: state, changed: pending, body: "" });
  if (validation.errors.length) throw new Error(validation.errors.join("\n"));
  return { state, packages, pending };
}

export function versionPublicPackages({ cwd }) {
  if (git(cwd, "status", "--porcelain", "--untracked-files=normal").toString().trim())
    throw new Error("Version preparation requires a clean worktree");
  const { state, packages, pending } = pendingPublicPackages({ cwd });
  if (!pending.length) return { changed: [], packages: [] };
  generatePackageVersions({ cwd, before: state, packages });
  const changed = [
    ...new Set(
      git(cwd, "ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z")
        .toString()
        .split("\0")
        .filter(Boolean),
    ),
  ];
  if (!changed.length || changed.some((path) => !versionFileAllowed(packages, path)))
    throw new Error(
      "Canonical version operation changed unexpected source, configuration or lockfile files",
    );
  for (const item of packages) {
    const manifest = JSON.parse(readFileSync(resolve(cwd, item.directory, "package.json"), "utf8"));
    if (manifest.name !== item.name || manifest.private === true)
      throw new Error("Qualified public set changed during version preparation");
  }
  return {
    changed,
    packages: packages
      .filter((item) => changed.includes(`${item.directory}/package.json`))
      .map((item) => item.name),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
    const cwd = process.cwd();
    if (values.check) {
      const count = pendingPublicPackages({ cwd }).pending.length;
      console.log(`pending=${count}`);
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(process.env.GITHUB_OUTPUT, `pending=${count}\n`);
    } else {
      const result = versionPublicPackages({ cwd });
      console.log(
        result.changed.length
          ? `Prepared canonical batch: ${result.packages.join(", ")}`
          : "No pending qualified Changesets; unchanged.",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
