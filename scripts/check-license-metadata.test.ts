import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const workspaces: string[] = [];
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-license-policy-"));
  workspaces.push(cwd);
  const write = (path: string, value: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  };
  write("package.json", '{"type":"module","private":true}\n');
  write(
    "scripts/public-packages.json",
    JSON.stringify({ schemaVersion: 1, packages: [{ directory: "packages/extension-cli" }] }),
  );
  copyFileSync(
    resolve(import.meta.dirname, "check-license-metadata.ts"),
    join(cwd, "scripts/check-license-metadata.ts"),
  );
  for (const name of ["core", "extension-cli", "extension-contracts"]) {
    write(
      `packages/${name}/package.json`,
      `${JSON.stringify({ name: `@openmapx/${name}`, version: "0.1.0", license: "Apache-2.0", private: true }, null, 2)}\n`,
    );
    copyFileSync(
      resolve(import.meta.dirname, "../packages/core/LICENSE"),
      join(cwd, `packages/${name}/LICENSE`),
    );
  }
  return {
    write,
    manifest: (name: string) =>
      JSON.parse(readFileSync(join(cwd, `packages/${name}/package.json`), "utf8")),
    run: (...args: string[]) =>
      spawnSync(process.execPath, ["scripts/check-license-metadata.ts", ...args], {
        cwd,
        encoding: "utf8",
      }),
  };
}
afterEach(() => {
  for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

it("repairs publication flags from the qualified boundary without changing licenses or versions", () => {
  const f = fixture();
  f.write(
    "packages/core/package.json",
    '{\n  "name": "@openmapx/core",\n  "version": "0.1.0",\n  "license": "Apache-2.0"\n}\n',
  );
  expect(f.run().status).toBe(1);
  const repair = f.run("--write");
  expect(repair.status, repair.stdout + repair.stderr).toBe(0);
  expect(f.manifest("core")).toMatchObject({
    private: true,
    license: "Apache-2.0",
    version: "0.1.0",
  });
  expect(f.manifest("extension-cli").private).toBeUndefined();
  expect(f.manifest("extension-contracts").private).toBe(true);
  const check = f.run();
  expect(check.status, check.stdout + check.stderr).toBe(0);
});
