import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strictReadFile } from "./durable-files";

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-release-reader-"));
  path = join(root, "state.json");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ops release authority reader", () => {
  it.each(["", "é🗺️"])("accepts exactly bounded UTF-8 bytes %j", (contents) => {
    writeFileSync(path, contents);
    expect(strictReadFile(path, Buffer.byteLength(contents))).toBe(contents);
  });
  it("preserves missing-file ENOENT for caller-specific handling", () => {
    expect(() => strictReadFile(path, 100)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
  it.each(["symlink", "hardlink", "directory", "oversize"])("rejects a %s", (kind) => {
    if (kind === "directory") mkdirSync(path);
    else if (kind === "symlink" || kind === "hardlink") {
      const target = join(root, "target");
      writeFileSync(target, "state");
      if (kind === "symlink") symlinkSync(target, path);
      else linkSync(target, path);
    } else writeFileSync(path, "123456");
    expect(() => strictReadFile(path, 5)).toThrow(/authority rejected/);
  });
  it("rejects invalid UTF-8 instead of substituting replacement characters", () => {
    writeFileSync(path, Buffer.from([0xff]));
    expect(() => strictReadFile(path, 1)).toThrow();
  });
  it.skipIf(process.platform === "win32")(
    "opens a FIFO nonblocking and rejects it before reading",
    () => {
      execFileSync("mkfifo", [path], { timeout: 3000 });
      const moduleUrl = new URL("./durable-files.ts", import.meta.url).href;
      const output = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { strictReadFile } from ${JSON.stringify(moduleUrl)};
       try { strictReadFile(process.argv[1], 100); process.exitCode = 1; }
       catch (error) { console.log(error.message); }`,
          path,
        ],
        { timeout: 3000, encoding: "utf8" },
      );
      expect(output.trim()).toBe("Release authority rejected");
    },
  );
});
