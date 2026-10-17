import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("Changesets release configuration", () => {
  it("keeps versioning private workspace packages under Changesets v3", () => {
    const config = JSON.parse(read(".changeset/config.json")) as {
      privatePackages?: { tag?: boolean; version?: boolean };
    };

    expect(config.privatePackages).toEqual({ version: true, tag: false });
  });

  it("uses the Changesets v2 action API and passes the release token as an input", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain(
      "changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2",
    );
    expect(workflow).toContain("github-token: $" + "{{ secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain("version-script: pnpm exec changeset version");
    expect(workflow).toContain('commit-message: "chore: version packages"');
    expect(workflow).toContain('pr-title: "chore: version packages"');
    expect(workflow).toContain("create-github-releases: true");
    expect(workflow).not.toMatch(/^\s+(version|commit|title|createGithubReleases):/m);
    expect(workflow).not.toContain("GITHUB_TOKEN:");
  });
});

// Exercise the installed CLI against a real Git workspace. The production break
// these cases catch is a Dockerfile-only change demanding a bookkeeping note,
// or the exclusion accidentally hiding source/manifests/shipped fixture changes.
const changesetCli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");

function changesetStatus(changes: Record<string, string>, note?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-changeset-contract-"));
  const write = (path: string, contents: string) => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdio: "pipe",
    });
  try {
    write("package.json", JSON.stringify({ name: "fixture", private: true }));
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(".changeset/config.json", read(".changeset/config.json"));
    write(
      "packages/app/package.json",
      JSON.stringify({ name: "@fixture/app", version: "1.0.0", private: true }),
    );
    write("packages/lib/package.json", JSON.stringify({ name: "@fixture/lib", version: "1.0.0" }));
    for (const path of [
      "packages/app/Dockerfile",
      "packages/app/src/index.ts",
      "packages/lib/src/index.ts",
      "packages/lib/fixtures/Dockerfile",
    ]) {
      write(path, "// baseline\n");
    }
    git("init", "--initial-branch=main");
    git("config", "user.name", "Changeset fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-m", "test: baseline");
    for (const [path, contents] of Object.entries(changes)) write(path, contents);
    if (note) write(".changeset/fixture-note.md", note);
    git("add", ".");
    const result = spawnSync(process.execPath, [changesetCli, "status", "--since=main"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("Changesets contribution detection", () => {
  it("does not require an empty note for a private image Dockerfile edit", () => {
    const result = changesetStatus({ "packages/app/Dockerfile": "FROM scratch\n" });
    expect(result.output).not.toContain("no changesets were found");
    expect(result.status).toBe(0);
  });

  it.each<[string, Record<string, string>]>([
    ["private application source", { "packages/app/src/index.ts": "export const value = 1;\n" }],
    ["public package source", { "packages/lib/src/index.ts": "export const value = 1;\n" }],
    [
      "a package manifest",
      {
        "packages/lib/package.json":
          '{"name":"@fixture/lib","version":"1.0.0","description":"changed"}',
      },
    ],
    [
      "a shipped nested Dockerfile fixture",
      { "packages/lib/fixtures/Dockerfile": "FROM scratch\n" },
    ],
    [
      "mixed Dockerfile and source edits",
      {
        "packages/app/Dockerfile": "FROM scratch\n",
        "packages/app/src/index.ts": "export const value = 1;\n",
      },
    ],
  ])("still rejects %s without a note", (_name, changes) => {
    const result = changesetStatus(changes);
    expect(result.output).toContain("no changesets were found");
    expect(result.status).toBe(1);
  });

  it("accepts a public source edit with a real release note", () => {
    const result = changesetStatus(
      { "packages/lib/src/index.ts": "export const value = 1;\n" },
      '---\n"@fixture/lib": patch\n---\nFix the exported value.\n',
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain("@fixture/lib");
  });
});
