import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = resolve(import.meta.dirname, "version-public-packages.mjs");
const gate = resolve(import.meta.dirname, "check-release-information.mjs");
function fixture(dependent = false) {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-version-public-"));
  roots.push(cwd);
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
    }).trim();
  write("package.json", { name: "fixture", private: true, packageManager: "pnpm@12.11.2" });
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters: {}\n");
  write(
    ".changeset/config.json",
    JSON.parse(readFileSync(resolve(import.meta.dirname, "../.changeset/config.json"), "utf8")),
  );
  write("scripts/public-packages.json", {
    schemaVersion: 1,
    packages: [
      {
        name: "@fixture/contracts",
        directory: "packages/contracts",
        bundleWorkspaceDependencies: false,
        versionedSchemas: "schemas",
      },
      { name: "@fixture/cli", directory: "packages/cli", bundleWorkspaceDependencies: false },
    ],
  });
  write("packages/contracts/package.json", { name: "@fixture/contracts", version: "0.1.0" });
  write("packages/contracts/schemas/value.json", {
    $id: "https://example.org/0.1.0/value.json",
    type: "object",
  });
  write("packages/cli/package.json", {
    name: "@fixture/cli",
    version: "0.1.0",
    ...(dependent ? { dependencies: { "@fixture/contracts": "workspace:~" } } : {}),
  });
  write("packages/private/package.json", {
    name: "@fixture/private",
    version: "0.1.0",
    private: true,
  });
  git("init", "--initial-branch=main");
  git("config", "user.name", "Version fixture");
  git("config", "user.email", "fixture@example.invalid");
  const commit = () => {
    git("add", ".");
    git("commit", "--allow-empty", "-qm", "test: fixture");
    return git("rev-parse", "HEAD");
  };
  commit();
  const note = (name = "@fixture/contracts", bump = "patch", slug = "release") =>
    write(
      `.changeset/${slug}.md`,
      `---\n"${name}": ${bump}\n---\nCorrect the consumer validation contract.\n`,
    );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 60000 });
  return {
    cwd,
    write,
    git,
    commit,
    note,
    run,
    json: (path: string) => JSON.parse(readFileSync(join(cwd, path), "utf8")),
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("installed canonical public version preparation", () => {
  it("leaves an empty queue entirely unchanged", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(result.stdout).toMatch(/no pending/i);
  });
  it.each(["patch", "minor"])(
    "generates a real %s batch and schema identity accepted by required CI",
    (bump) => {
      const f = fixture();
      f.note("@fixture/contracts", bump);
      const base = f.commit();
      const result = f.run();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const next = bump === "minor" ? "0.2.0" : "0.1.1";
      expect(f.json("packages/contracts/package.json").version).toBe(next);
      expect(f.json("packages/contracts/schemas/value.json").$id).toBe(
        `https://example.org/${next}/value.json`,
      );
      const head = f.commit();
      const check = spawnSync(
        process.execPath,
        [gate, "--cwd", f.cwd, "--base", base, "--head", head],
        { encoding: "utf8", timeout: 60000 },
      );
      expect(check.status, check.stdout + check.stderr).toBe(0);
    },
  );
  it("uses Changesets for multiple notes and required dependent releases", () => {
    const f = fixture(true);
    f.note("@fixture/contracts", "minor");
    f.note("@fixture/contracts", "patch", "another");
    f.commit();
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.json("packages/contracts/package.json").version).toBe("0.2.0");
    expect(f.json("packages/cli/package.json").version).toBe("0.1.1");
  });
  it.each(["@fixture/private", "@fixture/unknown"])(
    "rejects unqualified note %s before mutation",
    (name) => {
      const f = fixture();
      f.note(name);
      f.commit();
      const result = f.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/unqualified/);
      expect(f.git("status", "--porcelain")).toBe("");
    },
  );
  it("rejects malformed notes before mutation", () => {
    const f = fixture();
    f.write(".changeset/bad.md", "not frontmatter");
    f.commit();
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/frontmatter/);
    expect(f.git("status", "--porcelain")).toBe("");
  });
  it("rejects noncanonical note filenames rather than treating their queue as empty", () => {
    const f = fixture();
    f.write(
      ".changeset/UPPER.md",
      '---\n"@fixture/contracts": patch\n---\nFix consumer behavior.\n',
    );
    f.commit();
    const result = f.run("--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/filename/);
  });
  it("validates the queue without consuming it for the Action empty-queue guard", () => {
    const f = fixture();
    f.note();
    f.commit();
    const result = f.run("--check");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/pending=1/);
    expect(f.git("status", "--porcelain")).toBe("");
  });
});
