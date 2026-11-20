import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AnchoredDirectory } from "./filesystem";

let root: string;
let directory: AnchoredDirectory;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omx-anchored-")));
  directory = new AnchoredDirectory(root);
});
afterEach(() => {
  directory.close();
  rmSync(root, { recursive: true, force: true });
});

it("names a single component directly below the descriptor anchor", () => {
  expect(directory.name("osm")).toBe(join(directory.anchor, "osm"));
  expect(directory.name("..partition.parquet")).toBe(join(directory.anchor, "..partition.parquet"));
});

it("refuses names that are not one component below the anchor", () => {
  for (const name of ["", ".", "..", "../escape", "nested/name", "back\\slash", "nul\0", "/abs"])
    expect(() => directory.name(name), JSON.stringify(name)).toThrow("Unsafe filesystem component");
});
