import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StateStore } from "../src/state.js";

it.each(["symbolic", "hard"])(
  "publishes inventory without overwriting a %s-linked target",
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), "omx-state-publication-"));
    try {
      const target = join(root, "outside.json"),
        path = join(root, ".data-manager-state.json");
      const original = '{"datasets":[]}';
      writeFileSync(target, original);
      if (kind === "symbolic") symlinkSync(target, path);
      else linkSync(target, path);
      const store = new StateStore(root);
      store.replaceType("osm-pbf", []);
      expect(readFileSync(target, "utf8")).toBe(original);
      expect(lstatSync(path).isFile()).toBe(true);
      expect(lstatSync(path).nlink).toBe(1);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(new StateStore(root).getLoadDiagnostics().status).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
