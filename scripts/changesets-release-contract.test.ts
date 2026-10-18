import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const gate = resolve(import.meta.dirname, "check-release-information.mjs");
const workspaces: string[] = [];
const noRelease =
  "## Release and upgrade impact\n\nNo package release: Only the author verification tooling changes; installed artifacts are unchanged.\n";
const note = (name = "@fixture/lib") =>
  `---\n"${name}": patch\n---\nFix the consumer-facing validation result.\n`;
const fragment = (impacts = "migration") =>
  `---\nimpacts: [${impacts}]\n---\n## What changes\nThe database layout changes for stored observations.\n\n## Who is affected\nOperators upgrading an existing instance with stored data.\n\n## Required action\nRun the documented migration before restarting the API.\n`;

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-release-info-"));
  workspaces.push(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  write("package.json", '{"name":"fixture","private":true,"packageManager":"pnpm@12.11.2"}');
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters: {}\n");
  write(
    "scripts/public-packages.json",
    JSON.stringify({
      schemaVersion: 1,
      packages: [
        { name: "@fixture/lib", directory: "packages/lib", bundleWorkspaceDependencies: false },
        { name: "@fixture/tool", directory: "packages/tool", bundleWorkspaceDependencies: true },
      ],
    }),
  );
  write(
    ".changeset/config.json",
    JSON.stringify({
      changelog: "@changesets/cli/changelog",
      format: false,
      commit: false,
      fixed: [],
      linked: [],
      access: "public",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      privatePackages: { version: false, tag: false },
      ignore: [],
    }),
  );
  for (const [slug, manifest] of Object.entries({
    lib: { name: "@fixture/lib", version: "0.1.0" },
    tool: {
      name: "@fixture/tool",
      version: "0.1.0",
      files: ["dist", "templates"],
      devDependencies: { "@fixture/helper": "workspace:*" },
    },
    helper: { name: "@fixture/helper", version: "1.0.0", private: true },
    app: { name: "@fixture/app", version: "1.0.0", private: true },
  })) {
    write(`packages/${slug}/package.json`, JSON.stringify(manifest));
    write(`packages/${slug}/src/index.ts`, "export const value = 0;\n");
    write(`packages/${slug}/src/value.test.ts`, "// test baseline\n");
  }
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "test: baseline");
  let base = git("rev-parse", "HEAD");
  return {
    cwd,
    write,
    git,
    get base() {
      return base;
    },
    advanceBase() {
      base = git("rev-parse", "HEAD");
    },
    env,
    run(changes: Record<string, string | null>, body = "", author = "maintainer") {
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) rmSync(join(cwd, path), { force: true });
        else write(path, content);
      }
      git("add", "--all");
      git("commit", "--allow-empty", "-m", "test: candidate");
      const head = git("rev-parse", "HEAD");
      write(
        "pr.json",
        JSON.stringify({ body, base: { sha: base }, head: { sha: head }, user: { login: author } }),
      );
      const result = spawnSync(
        process.execPath,
        [gate, "--cwd", cwd, "--base", base, "--head", head, "--pr-json", join(cwd, "pr.json")],
        { encoding: "utf8", env, timeout: 30000 },
      );
      if (result.error) throw result.error;
      return { status: result.status, output: result.stdout + result.stderr, head };
    },
  };
}
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("conditional contribution release information", () => {
  it("accepts private-only maintenance without bookkeeping notes", () => {
    expect(fixture().run({ "packages/app/src/index.ts": "export const value = 1;" }).status).toBe(
      0,
    );
  });
  it.each(["maintainer", "dependabot[bot]"])(
    "requires public artifact coverage for %s",
    (author) => {
      const result = fixture().run(
        { "packages/lib/src/index.ts": "export const value = 1;" },
        "",
        author,
      );
      expect(result.status).toBe(1);
      expect(result.output).toContain("@fixture/lib");
    },
  );
  it("accepts an affected-package Changeset", () => {
    expect(
      fixture().run({
        "packages/lib/src/index.ts": "export const value = 1;",
        ".changeset/fix.md": note(),
      }).status,
    ).toBe(0);
  });
  it("accepts explicit non-release reasoning in the correct PR section", () => {
    expect(
      fixture().run({ "packages/lib/README.md": "Explain a development-only check." }, noRelease)
        .status,
    ).toBe(0);
  });
  it.each([
    "## Summary\nNo package release: Only test tooling changes and the artifacts stay the same.",
    `## Release and upgrade impact\n<!-- No package release: Only test tooling changes and the artifacts stay the same. -->`,
    `## Release and upgrade impact\n\n\`\`\`\nNo package release: Only test tooling changes and the artifacts stay the same.\n\`\`\``,
    "## Release and upgrade impact\nNo package release: N/A",
  ])("rejects hidden or unjustified reasoning: %s", (body) => {
    expect(
      fixture().run({ "packages/lib/src/index.ts": "export const value = 1;" }, body).status,
    ).toBe(1);
  });
  it("automatically accepts public tests-only edits", () => {
    expect(fixture().run({ "packages/lib/src/value.test.ts": "// new assertions" }).status).toBe(0);
  });
  it.each(["packages/lib/schemas/value.json", "packages/tool/templates/integration/README.md"])(
    "treats shipped files as artifact impact: %s",
    (path) => {
      expect(fixture().run({ [path]: "{}" }).status).toBe(1);
    },
  );
  it("tracks private source bundled into the public CLI", () => {
    const result = fixture().run({ "packages/helper/src/index.ts": "export const value = 1;" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("@fixture/tool");
  });
  it("requires coverage for package runtime dependency changes", () => {
    expect(
      fixture().run({
        "packages/lib/package.json":
          '{"name":"@fixture/lib","version":"0.1.0","dependencies":{"zod":"4.0.0"}}',
      }).status,
    ).toBe(1);
  });
  it("does not lose the old path of renamed source", () => {
    expect(
      fixture().run({
        "packages/lib/src/index.ts": null,
        "archive/index.ts": "export const value = 0;",
      }).status,
    ).toBe(1);
  });
  it("requires both public packages for an unclassified lockfile change", () => {
    const result = fixture().run({
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {changed: {}}\n",
      ".changeset/fix.md": note(),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("@fixture/tool");
  });
  it.each([
    "---\n---\n",
    "---\n{}\n---\nEmpty bookkeeping.\n",
    '---\n"@fixture/lib": bananas\n---\nInvalid bump.\n',
    note("@fixture/app"),
    '---\n"@fixture/lib": patch\n"@fixture/lib": minor\n---\nDuplicate key.\n',
    '---\n"@fixture/lib": patch\n---\n',
  ])("rejects malformed, empty or unqualified notes: %s", (contents) => {
    expect(fixture().run({ ".changeset/bad.md": contents }).status).toBe(1);
  });
  it("does not let an unrelated note cover a public edit", () => {
    expect(
      fixture().run({
        "packages/lib/src/index.ts": "export const value=1;",
        ".changeset/tool.md": note("@fixture/tool"),
      }).status,
    ).toBe(1);
  });
  it("does not let a pre-existing note cover a new edit", () => {
    const f = fixture();
    f.write(".changeset/old.md", note());
    f.git("add", ".");
    f.git("commit", "-m", "test: existing note");
    f.advanceBase();
    expect(f.run({ "packages/lib/src/index.ts": "export const value=1;" }).status).toBe(1);
  });
});

describe("important product fragments", () => {
  const body = "## Release and upgrade impact\n\nProduct impact: migration\n";
  it("does not require a fragment for ordinary product work", () => {
    expect(fixture().run({ "apps/api/src/value.ts": "// product fix" }).status).toBe(0);
  });
  it("requires a committed fragment for a declared important impact", () => {
    expect(fixture().run({ "apps/api/src/value.ts": "// migration" }, body).status).toBe(1);
  });
  it("requires all declared categories", () => {
    expect(
      fixture().run(
        { "release-notes/change.md": fragment() },
        body.replace("migration", "migration, security"),
      ).status,
    ).toBe(1);
  });
  it("accepts a product migration fragment independently of package notes", () => {
    expect(
      fixture().run(
        { "apps/api/src/value.ts": "// migration", "release-notes/change.md": fragment() },
        body,
      ).status,
    ).toBe(0);
  });
  it("automatically requires migration information for database SQL changes", () => {
    expect(
      fixture().run({
        "apps/api/src/db/migrations/0099_change.sql": "ALTER TABLE example ADD COLUMN value text;",
      }).status,
    ).toBe(1);
  });
  it("requires both audiences' notes on a mixed change", () => {
    expect(
      fixture().run(
        {
          "packages/lib/src/index.ts": "export const value=1;",
          "release-notes/change.md": fragment(),
        },
        body,
      ).status,
    ).toBe(1);
  });
  it.each([
    fragment().replace("## Required action", "## Other"),
    fragment().replace("migration", "unknown"),
    fragment().replace("Run the documented migration before restarting the API.", "TODO"),
  ])("rejects an incomplete fragment", (contents) => {
    expect(fixture().run({ "release-notes/change.md": contents }, body).status).toBe(1);
  });
  it("rejects PR metadata for a different head", () => {
    const f = fixture();
    const result = f.run({});
    f.write("pr.json", JSON.stringify({ head: { sha: "a".repeat(40) }, body: noRelease }));
    const rerun = spawnSync(
      process.execPath,
      [
        gate,
        "--cwd",
        f.cwd,
        "--base",
        f.base,
        "--head",
        result.head,
        "--pr-json",
        join(f.cwd, "pr.json"),
      ],
      { encoding: "utf8" },
    );
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain("head");
  });
});

const changesetCli = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");
function versionCandidate() {
  const f = fixture();
  f.write(".changeset/release.md", note());
  f.git("add", ".");
  f.git("commit", "-m", "test: pending public release");
  f.advanceBase();
  const version = spawnSync(process.execPath, [changesetCli, "version"], {
    cwd: f.cwd,
    env: f.env,
    encoding: "utf8",
    timeout: 20000,
  });
  expect(version.status, version.stdout + version.stderr).toBe(0);
  return f;
}
describe("canonical generated package versions", () => {
  const body = "## Release and upgrade impact\n\nPackage release: version\n";
  it("accepts the real Changesets transformation without another note", () => {
    const result = versionCandidate().run({}, body);
    expect(result.status, result.output).toBe(0);
  });
  it("recognizes a real version delta without relying on PR identity", () => {
    const result = versionCandidate().run({}, "", "arbitrary-author");
    expect(result.status, result.output).toBe(0);
  });
  it.each([
    [
      "forged version",
      { "packages/lib/package.json": '{"name":"@fixture/lib","version":"0.9.0"}' },
    ],
    ["changed changelog", { "packages/lib/CHANGELOG.md": "# Invented release history" }],
    ["source tampering", { "packages/lib/src/index.ts": "export const value=999;" }],
    ["configuration tampering", { ".changeset/config.json": "{}" }],
    ["new lockfile", { "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {forged: {}}\n" }],
  ] as [string, Record<string, string>][])("rejects %s", (_name, changes) => {
    const result = versionCandidate().run(changes, body);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/canonical/i);
  });
  it("rejects a version label with no actual version batch", () => {
    expect(fixture().run({}, body).status).toBe(1);
  });
  it("cannot hide a forged manifest version behind a non-release reason", () => {
    expect(
      fixture().run(
        { "packages/lib/package.json": '{"name":"@fixture/lib","version":"0.9.0"}' },
        noRelease,
      ).status,
    ).toBe(1);
  });
  it("blocks the unreconciled legacy queue before a version operation", () => {
    const f = fixture();
    f.write(".changeset/legacy.md", note("@fixture/app"));
    f.git("add", ".");
    f.git("commit", "-m", "test: legacy mixed queue");
    f.advanceBase();
    const result = f.run({}, body);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/qualified|baseline/i);
  });
});

describe("versioned schema identities", () => {
  function candidate(update = true, tamper = false) {
    const f = fixture();
    const config = JSON.parse(readFileSync(join(f.cwd, "scripts/public-packages.json"), "utf8"));
    config.packages[0].versionedSchemas = "schemas";
    f.write("scripts/public-packages.json", JSON.stringify(config));
    f.write(
      "packages/lib/schemas/value.json",
      `${JSON.stringify({ $id: "https://example.org/0.1.0/value.json", type: "object" }, null, 2)}\n`,
    );
    f.write(".changeset/release.md", note());
    f.git("add", ".");
    f.git("commit", "-m", "test: pending schema package");
    f.advanceBase();
    const version = spawnSync(process.execPath, [changesetCli, "version"], {
      cwd: f.cwd,
      env: f.env,
      encoding: "utf8",
      timeout: 20000,
    });
    expect(version.status, version.stdout + version.stderr).toBe(0);
    if (update)
      f.write(
        "packages/lib/schemas/value.json",
        `${JSON.stringify({ $id: "https://example.org/0.1.1/value.json", type: tamper ? "string" : "object" }, null, 2)}\n`,
      );
    return f.run({}, "## Release and upgrade impact\nPackage release: version\n");
  }
  it("accepts exact schema id regeneration alongside the version bump", () => {
    const result = candidate();
    expect(result.status, result.output).toBe(0);
  });
  it("rejects stale schema ids", () => expect(candidate(false).status).toBe(1));
  it("rejects schema structure changes disguised as version regeneration", () =>
    expect(candidate(true, true).status).toBe(1));
});

describe("review regressions: metadata and artifact boundaries", () => {
  it.each([
    "## Release and upgrade impact\n<!--\nNo package release: Only development tooling changes; shipped behavior stays unchanged.",
    "## Release and upgrade impact\n```text\nNo package release: Only development tooling changes; shipped behavior stays unchanged.",
    "## Release and upgrade impact\n~~~text\nNo package release: Only development tooling changes; shipped behavior stays unchanged.\n~~~~",
    `${noRelease}\n## Release and upgrade impact\nProduct impact: security\n`,
  ])("rejects hidden examples and conflicting repeated sections", (body) => {
    const result = fixture().run({ "packages/lib/src/index.ts": "export const value=1;" }, body);
    expect(result.status, result.output).toBe(1);
  });
  it.each(["example.test.ts", "__tests__/example.ts"])(
    "does not exempt shipped template %s",
    (file) => {
      const result = fixture().run({
        [`packages/tool/templates/integration/${file}`]: "export const value=1;",
      });
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain("@fixture/tool");
    },
  );
  it("rejects a same-head stale base after retargeting and evaluates the current diff", () => {
    const f = fixture();
    const earlier = f.base;
    f.write("packages/lib/src/index.ts", "export const value=1;");
    f.git("add", ".");
    f.git("commit", "-m", "test: prior base change");
    f.advanceBase();
    const result = f.run({ "packages/app/src/index.ts": "export const value=2;" });
    expect(result.status, result.output).toBe(0);
    f.write(
      "pr.json",
      JSON.stringify({ head: { sha: result.head }, base: { sha: earlier }, body: "" }),
    );
    const run = (base: string) =>
      spawnSync(
        process.execPath,
        [
          gate,
          "--cwd",
          f.cwd,
          "--base",
          base,
          "--head",
          result.head,
          "--pr-json",
          join(f.cwd, "pr.json"),
        ],
        { encoding: "utf8", env: f.env },
      );
    const stale = run(f.base);
    expect(stale.status, stale.stdout + stale.stderr).toBe(1);
    expect(stale.stderr).toMatch(/base/i);
    const current = run(earlier);
    expect(current.status).toBe(1);
    expect(current.stderr).toContain("@fixture/lib");
  });
  it("cannot hide new important product declarations in a canonical version batch", () => {
    const result = versionCandidate().run(
      {},
      "## Release and upgrade impact\nPackage release: version\nProduct impact: security, operator-action\n",
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/product|fragment/i);
  });
});
