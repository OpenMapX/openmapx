import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { prepareReleaseRecord } from "./prepare-product-release.mjs";
import { fixture } from "./product-release.fixtures";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

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

it.each([false, true])(
  "preserves notes created concurrently (selected fragments: %s)",
  async (withFragment) => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-prepare-race-"));
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    try {
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["remote", "add", "origin", root], { cwd: root });
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "release-notes"));
      const configPath = join(root, "scripts/product-release.json");
      const original = JSON.stringify(fixture().configuration);
      writeFileSync(configPath, original);
      writeFileSync(join(root, "release-notes/migration.md"), "Explicit selected fragment.\n");
      const notesPath = join(root, "docs/docs/releases/0.1.0-alpha.2.md");
      const authored = "Concurrent authored notes must survive.\n";
      let collided = false;
      vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
        if (String(file) === notesPath && !collided) {
          collided = true;
          actual.writeFileSync(file, authored);
        }
        actual.writeFileSync(file, data, options);
      });
      const prepare = () =>
        prepareReleaseRecord(
          root,
          "0.1.0-alpha.2",
          withFragment ? ["release-notes/migration.md"] : [],
        );
      if (withFragment) {
        expect(prepare).toThrow("Notes already exist");
        expect(readFileSync(configPath, "utf8")).toBe(original);
      } else {
        expect(prepare().version).toBe("0.1.0-alpha.2");
      }
      expect(collided).toBe(true);
      expect(readFileSync(notesPath, "utf8")).toBe(authored);
    } finally {
      vi.mocked(writeFileSync).mockImplementation(actual.writeFileSync);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
