import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { versionPublicPackages } from "../version-public-packages.mjs";

/** Real installed-Changesets PR head and a later squash merge, with fake GH reads. */
export function packageReleaseSourceFixture(tamper = false) {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-package-source-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const write = (path: string, data: unknown) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(
      join(cwd, path),
      typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
    );
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "test: source fixture");
    return git("rev-parse", "HEAD");
  };
  write("package.json", { name: "fixture", private: true, packageManager: "pnpm@12.11.2" });
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    ".changeset/config.json",
    readFileSync(resolve(import.meta.dirname, "../../.changeset/config.json"), "utf8"),
  );
  write("scripts/public-packages.json", {
    schemaVersion: 1,
    packages: ["extension-contracts", "extension-cli"].map((slug) => ({
      name: `@openmapx/${slug}`,
      directory: `packages/${slug}`,
      bundleWorkspaceDependencies: false,
    })),
  });
  for (const slug of ["extension-contracts", "extension-cli"])
    write(`packages/${slug}/package.json`, { name: `@openmapx/${slug}`, version: "0.1.0" });
  write(
    ".changeset/release.md",
    '---\n"@openmapx/extension-contracts": patch\n---\nFix validation for independent consumers.\n',
  );
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "fixture@example.invalid");
  commit();
  git("switch", "-c", "version");
  versionPublicPackages({ cwd });
  if (tamper) write("packages/extension-contracts/source.ts", "export const unexpected = true;\n");
  const headSha = commit();
  git("switch", "main");
  write("unrelated.txt", "main advanced before squash\n");
  commit();
  git("merge", "--squash", "version");
  const source = commit();
  const repo = { full_name: "OpenMapX/openmapx" };
  const ci = {
    id: 90,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
    head_sha: source,
    head_branch: "main",
    event: "push",
    repository: repo,
    head_repository: repo,
  };
  const pr = {
    number: 40,
    merged: true,
    merge_commit_sha: source,
    body: "## Release and upgrade impact\nPackage release: version\n",
    base: { ref: "main", repo },
    head: { sha: headSha, repo },
  };
  const context = {
    repository: "OpenMapX/openmapx",
    sha: source,
    ref: "refs/heads/main",
    workflowRef: "OpenMapX/openmapx/.github/workflows/package-release.yml@refs/heads/main",
    runId: 100,
    attempt: 1,
  };
  const calls: string[] = [];
  const run = (executable: string, args: string[], options: object = {}) => {
    if (executable === "gh") {
      calls.push(args[1]);
      return JSON.stringify(args[1].includes("pulls/") ? pr : ci);
    }
    if (executable === "git" && args[0] === "fetch") return "";
    if (args.includes("publish-plan")) {
      writeFileSync(
        args[args.indexOf("--output") + 1],
        JSON.stringify({
          version: 1,
          plan: [
            [
              {
                kind: "publish",
                name: "@openmapx/extension-contracts",
                version: "0.1.1",
                access: "public",
                tag: "latest",
              },
            ],
          ],
        }),
      );
      return "";
    }
    return execFileSync(executable, args, { cwd, env, encoding: "utf8", ...options }).trim();
  };
  return {
    cwd,
    calls,
    run,
    request: { operation: "publish", context, sourceRunId: 90, versionPr: 40 },
  };
}
