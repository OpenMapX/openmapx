import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyHardlinkPlan } from "./index";

describe("hardlink containment with symlinks", () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "omx-hl-root-"));
    outside = mkdtempSync(join(tmpdir(), "omx-hl-out-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    // A symlink inside the root that points outside it.
    symlinkSync(outside, join(root, "escape"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a source that resolves outside the root via a symlink", () => {
    expect(() =>
      applyHardlinkPlan(
        [
          {
            source: "escape",
            target: "consumer",
            consumerService: "test",
            dataType: "test",
          },
        ],
        { rootDir: root },
      ),
    ).toThrow(/escapes the data root/);
  });
});
