import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyRuntimePackages } from "./copy-runtime-packages.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-runtime-packages-"));
  roots.push(root);
  return root;
}

/** A pnpm layout: package `a` depends on `b`, `@s/d` and `c`. */
function install(): string {
  const root = directory();
  const files: Record<string, string> = {
    "node_modules/.pnpm/a@1/node_modules/a/index.js":
      'module.exports = require("b") + require("@s/d");',
    "node_modules/.pnpm/a@1/node_modules/a/LICENSE": "MIT",
    "node_modules/.pnpm/b@1/node_modules/b/index.js": 'module.exports = "b";',
    "node_modules/.pnpm/c@1/node_modules/c/index.js": 'module.exports = "c";',
    "node_modules/.pnpm/@s+d@1/node_modules/@s/d/index.js": 'module.exports = "d";',
    "node_modules/.pnpm/@t+tool@1/node_modules/@t/tool/index.js": 'require("b");',
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  const links: Record<string, string> = {
    "node_modules/.pnpm/a@1/node_modules/b": "../../b@1/node_modules/b",
    "node_modules/.pnpm/a@1/node_modules/c": "../../c@1/node_modules/c",
    "node_modules/.pnpm/a@1/node_modules/@s/d": "../../../@s+d@1/node_modules/@s/d",
    "node_modules/.pnpm/node_modules/b": "../b@1/node_modules/b",
    // A scoped package left behind that links to a kept one.
    "node_modules/.pnpm/@t+tool@1/node_modules/b": "../../b@1/node_modules/b",
    "node_modules/.pnpm/node_modules/c": "../c@1/node_modules/c",
    "node_modules/a": ".pnpm/a@1/node_modules/a",
    "node_modules/@openmapx/core": "../../packages/core",
  };
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  return root;
}

const KEPT = [
  "node_modules/.pnpm/@s+d@1/node_modules/@s/d",
  "node_modules/.pnpm/a@1/node_modules/a",
  "node_modules/.pnpm/b@1/node_modules/b",
];

describe("copyRuntimePackages", () => {
  it("copies the listed packages and only the links that resolve to them", () => {
    const from = install();
    const to = directory();
    copyRuntimePackages(KEPT, from, to);

    const load = createRequire(import.meta.url);
    expect(load(join(to, "node_modules/a/index.js"))).toBe("bd");
    expect(existsSync(join(to, "node_modules/.pnpm/a@1/node_modules/a/LICENSE"))).toBe(true);
    expect(readlinkSync(join(to, "node_modules/.pnpm/a@1/node_modules/b"))).toBe(
      "../../b@1/node_modules/b",
    );
    expect(readlinkSync(join(to, "node_modules/.pnpm/node_modules/b"))).toBe(
      "../b@1/node_modules/b",
    );
    for (const path of [
      "node_modules/.pnpm/c@1",
      "node_modules/.pnpm/a@1/node_modules/c",
      "node_modules/.pnpm/node_modules/c",
      "node_modules/.pnpm/@t+tool@1",
      "node_modules/@openmapx",
    ]) {
      expect(existsSync(join(to, path)), path).toBe(false);
    }
  });

  it("rejects a listed package the install does not have", () => {
    expect(() =>
      copyRuntimePackages(
        [...KEPT, "node_modules/.pnpm/e@1/node_modules/e"],
        install(),
        directory(),
      ),
    ).toThrow("The install has no node_modules/.pnpm/e@1/node_modules/e");
  });
});
