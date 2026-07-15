import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aliasSlot,
  commitMotisSlotActivation,
  ensureMotisSlotLayout,
  flipMotisSlotAliases,
  reconcileMotisSlotLayout,
} from "../../src/jobs/transitous/slot-state.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), "openmapx-motis-slots-"));
  return ensureMotisSlotLayout(root);
}

describe("MOTIS two-slot state", () => {
  it("migrates primary/staging directories into A/B aliases without reimport", () => {
    root = mkdtempSync(join(tmpdir(), "openmapx-motis-slots-migrate-"));
    mkdirSync(join(root, "motis", "live"), { recursive: true });
    mkdirSync(join(root, "motis", "staging"), { recursive: true });
    writeFileSync(join(root, "motis", "live", "active.txt"), "active");
    writeFileSync(join(root, "motis", "staging", "candidate.txt"), "candidate");

    const layout = ensureMotisSlotLayout(root);

    expect(aliasSlot(layout, "live")).toBe("A");
    expect(aliasSlot(layout, "staging")).toBe("B");
    expect(readFileSync(join(layout.slots.A, "active.txt"), "utf-8")).toBe("active");
    expect(readFileSync(join(layout.slots.B, "candidate.txt"), "utf-8")).toBe("candidate");
  });

  it("atomically flips aliases and persists the proven epoch", () => {
    const layout = fixture();
    flipMotisSlotAliases(layout, "B");
    expect(aliasSlot(layout, "live")).toBe("B");
    expect(aliasSlot(layout, "staging")).toBe("A");

    const record = commitMotisSlotActivation(layout, {
      activeSlot: "B",
      datasetEpoch: "epoch-2",
      manifestHash: "hash-2",
      imageDigest: "sha256:image",
      activatedAt: "2026-07-15T12:00:00Z",
    });
    expect(record).toMatchObject({
      activeSlot: "B",
      previousHealthySlot: "A",
      datasetEpoch: "epoch-2",
    });
    expect(existsSync(layout.statePath)).toBe(true);
  });

  it("reconciles a crash-after-flip to the last recorded healthy slot", () => {
    const layout = fixture();
    flipMotisSlotAliases(layout, "B");
    expect(aliasSlot(layout, "live")).toBe("B");

    reconcileMotisSlotLayout(layout);

    expect(aliasSlot(layout, "live")).toBe("A");
    expect(aliasSlot(layout, "staging")).toBe("B");
  });
});
