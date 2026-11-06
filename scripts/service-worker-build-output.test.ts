import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("stamps two deployment identities into built public and standalone service workers", () => {
  const web = resolve(import.meta.dirname, "../apps/web");
  const temp = mkdtempSync(join(tmpdir(), "openmapx-sw-output-"));
  const webRequire = createRequire(join(web, "package.json"));
  try {
    mkdirSync(join(temp, "scripts"));
    mkdirSync(join(temp, "node_modules"));
    for (const name of ["esbuild", "maplibre-gl"]) {
      symlinkSync(
        dirname(webRequire.resolve(`${name}/package.json`)),
        join(temp, "node_modules", name),
        "dir",
      );
    }
    symlinkSync(join(web, "src"), join(temp, "src"), "dir");
    for (const name of ["build-sw.mjs", "maplibre-runtime.mjs"])
      copyFileSync(join(web, "scripts", name), join(temp, "scripts", name));
    mkdirSync(join(temp, ".next/static"), { recursive: true });
    writeFileSync(join(temp, ".next/static/probe.js"), "static payload");
    const copy = JSON.parse(readFileSync(join(web, "package.json"), "utf8")).scripts[
      "build:copy-assets"
    ];
    const outputs = [];
    for (const id of ["first-deployment-id", "second-deployment-id"]) {
      execFileSync(process.execPath, [join(temp, "scripts/build-sw.mjs")], {
        cwd: temp,
        env: { ...process.env, SW_BUILD_ID: id },
        stdio: "pipe",
      });
      execFileSync("sh", ["-c", copy], { cwd: temp, stdio: "pipe" });
      const built = readFileSync(join(temp, "public/sw.js"), "utf8");
      expect(built).toContain(id);
      expect(readFileSync(join(temp, ".next/standalone/apps/web/public/sw.js"), "utf8")).toBe(
        built,
      );
      expect(
        readFileSync(join(temp, ".next/standalone/apps/web/.next/static/probe.js"), "utf8"),
      ).toBe("static payload");
      outputs.push(built);
    }
    expect(outputs[0]).not.toBe(outputs[1]);
    expect(outputs[1]).not.toContain("first-deployment-id");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 30000);
