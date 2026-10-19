import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanLicenses } from "../licenses";

describe("scanLicenses", () => {
  const tempDirs: string[] = [];

  function makeFixtureRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "openmapx-licenses-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts matching SPDX license text from a REUSE LICENSES/ directory", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        dependencies: {
          "reuse-pkg": "1.0.0",
        },
      }),
    );

    const pkgDir = join(root, "node_modules", "reuse-pkg");
    mkdirSync(join(pkgDir, "LICENSES"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "reuse-pkg",
        version: "1.0.0",
        license: "LGPL-3.0-only",
        main: "index.js",
      }),
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
    writeFileSync(
      join(pkgDir, "LICENSES", "LGPL-3.0-only.txt"),
      "GNU LESSER GENERAL PUBLIC LICENSE Version 3",
    );
    writeFileSync(
      join(pkgDir, "LICENSES", "AGPL-3.0-only.txt"),
      "GNU AFFERO GENERAL PUBLIC LICENSE Version 3 (demo site only)",
    );
    writeFileSync(join(pkgDir, "LICENSES", "CC0-1.0.txt"), "CC0 1.0 Universal (config files)");

    const notices = scanLicenses({
      rootPackageJsonPaths: [join(root, "package.json")],
    });

    expect(notices).toEqual([
      {
        name: "reuse-pkg",
        version: "1.0.0",
        license: "LGPL-3.0-only",
        licenseText: "GNU LESSER GENERAL PUBLIC LICENSE Version 3",
      },
    ]);
  });

  it("concatenates multiple matching SPDX files in LICENSES/ for compound license expressions", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        dependencies: {
          "compound-reuse-pkg": "2.0.0",
        },
      }),
    );

    const pkgDir = join(root, "node_modules", "compound-reuse-pkg");
    mkdirSync(join(pkgDir, "LICENSES"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "compound-reuse-pkg",
        version: "2.0.0",
        license: "(MIT OR CC0-1.0)",
        main: "index.js",
      }),
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
    writeFileSync(join(pkgDir, "LICENSES", "MIT.txt"), "MIT License Text");
    writeFileSync(join(pkgDir, "LICENSES", "CC0-1.0.txt"), "CC0 1.0 Universal Text");
    writeFileSync(join(pkgDir, "LICENSES", "BSD-3-Clause.txt"), "Unreferenced BSD Text");

    const notices = scanLicenses({
      rootPackageJsonPaths: [join(root, "package.json")],
    });

    expect(notices).toEqual([
      {
        name: "compound-reuse-pkg",
        version: "2.0.0",
        license: "(MIT OR CC0-1.0)",
        licenseText: "MIT License Text\n\n---\n\nCC0 1.0 Universal Text",
      },
    ]);
  });

  it("falls back to all text files in LICENSES/ when declared license does not match a file stem", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        dependencies: {
          "custom-dir-pkg": "1.2.0",
        },
      }),
    );

    const pkgDir = join(root, "node_modules", "custom-dir-pkg");
    mkdirSync(join(pkgDir, "licenses"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "custom-dir-pkg",
        version: "1.2.0",
        license: "Custom",
        main: "index.js",
      }),
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
    writeFileSync(join(pkgDir, "licenses", "custom-terms.txt"), "Custom License Terms");

    const notices = scanLicenses({
      rootPackageJsonPaths: [join(root, "package.json")],
    });

    expect(notices).toEqual([
      {
        name: "custom-dir-pkg",
        version: "1.2.0",
        license: "Custom",
        licenseText: "Custom License Terms",
      },
    ]);
  });

  it("discovers British-spelled LICENCE files and suffixed/dual root license files while ignoring code files", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        dependencies: {
          "british-pkg": "1.0.0",
          "dual-root-pkg": "1.0.0",
          "suffixed-pkg": "1.0.0",
        },
      }),
    );

    const britishDir = join(root, "node_modules", "british-pkg");
    mkdirSync(britishDir, { recursive: true });
    writeFileSync(
      join(britishDir, "package.json"),
      JSON.stringify({
        name: "british-pkg",
        version: "1.0.0",
        license: "MIT",
        main: "index.js",
      }),
    );
    writeFileSync(join(britishDir, "index.js"), "module.exports = {};\n");
    writeFileSync(join(britishDir, "LICENCE.md"), "British MIT Licence");

    const dualDir = join(root, "node_modules", "dual-root-pkg");
    mkdirSync(dualDir, { recursive: true });
    writeFileSync(
      join(dualDir, "package.json"),
      JSON.stringify({
        name: "dual-root-pkg",
        version: "1.0.0",
        license: "(MIT OR CC0-1.0)",
        main: "index.js",
      }),
    );
    writeFileSync(join(dualDir, "index.js"), "module.exports = {};\n");
    writeFileSync(join(dualDir, "license-cc0"), "CC0 Text");
    writeFileSync(join(dualDir, "license-mit"), "MIT Text");
    writeFileSync(join(dualDir, "license.js"), "module.exports = 'not a license text';\n");
    writeFileSync(join(dualDir, "license.d.ts"), "export declare const x: string;\n");

    const suffixedDir = join(root, "node_modules", "suffixed-pkg");
    mkdirSync(suffixedDir, { recursive: true });
    writeFileSync(
      join(suffixedDir, "package.json"),
      JSON.stringify({
        name: "suffixed-pkg",
        version: "1.0.0",
        license: "BSD-2-Clause",
        main: "index.js",
      }),
    );
    writeFileSync(join(suffixedDir, "index.js"), "module.exports = {};\n");
    writeFileSync(join(suffixedDir, "LICENSE.BSD"), "BSD 2-Clause Text");

    const notices = scanLicenses({
      rootPackageJsonPaths: [join(root, "package.json")],
    });

    expect(notices).toEqual([
      {
        name: "british-pkg",
        version: "1.0.0",
        license: "MIT",
        licenseText: "British MIT Licence",
      },
      {
        name: "dual-root-pkg",
        version: "1.0.0",
        license: "(MIT OR CC0-1.0)",
        licenseText: "CC0 Text\n\n---\n\nMIT Text",
      },
      {
        name: "suffixed-pkg",
        version: "1.0.0",
        license: "BSD-2-Clause",
        licenseText: "BSD 2-Clause Text",
      },
    ]);
  });

  it("skips subdirectory module-type package.json markers when package exports block ./package.json", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        dependencies: {
          "dual-cjs-pkg": "3.4.9",
        },
      }),
    );

    const pkgDir = join(root, "node_modules", "dual-cjs-pkg");
    const cjsDir = join(pkgDir, "dist", "cjs");
    mkdirSync(cjsDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "dual-cjs-pkg",
        version: "3.4.9",
        license: "ISC",
        exports: {
          ".": "./dist/cjs/index.js",
        },
      }),
    );
    writeFileSync(join(pkgDir, "LICENSE"), "ISC License Body");
    writeFileSync(join(cjsDir, "package.json"), JSON.stringify({ type: "commonjs" }));
    writeFileSync(join(cjsDir, "index.js"), "module.exports = {};\n");

    const notices = scanLicenses({
      rootPackageJsonPaths: [join(root, "package.json")],
    });

    expect(notices).toEqual([
      {
        name: "dual-cjs-pkg",
        version: "3.4.9",
        license: "ISC",
        licenseText: "ISC License Body",
      },
    ]);
  });
});
