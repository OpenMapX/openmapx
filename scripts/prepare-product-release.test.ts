import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareReleaseRecord } from "./prepare-product-release.mjs";
import { fixture } from "./product-release.fixtures";

it("prepares only local metadata and deliberately selected notes without publication", () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-prepare-fixture-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["remote", "add", "origin", root], { cwd: root });
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "release-notes"));
    writeFileSync(
      join(root, "scripts/product-release.json"),
      JSON.stringify(fixture().configuration),
    );
    writeFileSync(
      join(root, "release-notes/migration.md"),
      "---\nimpact: migration\n---\n\nExplicit synthetic migration instruction.\n",
    );
    const next = prepareReleaseRecord(root, "0.1.0-alpha.2", ["release-notes/migration.md"]);
    expect(readFileSync(join(root, next.notesPath), "utf8")).toContain(
      "Explicit synthetic migration instruction.",
    );
    expect(execFileSync("git", ["tag"], { cwd: root, encoding: "utf8" })).toBe("");
    expect(() => prepareReleaseRecord(root, "0.1.0-alpha.3", ["../secret"])).toThrow();
    expect(
      JSON.parse(readFileSync(join(root, "scripts/product-release.json"), "utf8")).version,
    ).toBe("0.1.0-alpha.2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
