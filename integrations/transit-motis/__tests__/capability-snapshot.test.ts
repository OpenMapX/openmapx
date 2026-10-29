import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { createTransitMotisInstances } from "../instances.js";
import { setupLocal } from "../local.js";

const race = vi.hoisted(() => ({
  replace: undefined as undefined | (() => void),
  closeError: false,
}));
vi.mock("node:fs", async (load) => {
  const original = await load<typeof import("node:fs")>();
  const replace = () => {
    const action = race.replace;
    race.replace = undefined;
    action?.();
  };
  return {
    ...original,
    closeSync: (descriptor: number) => {
      original.closeSync(descriptor);
      if (race.closeError) throw new Error("File close failed");
    },
    statSync: (...args: Parameters<typeof original.statSync>) => {
      const stats = original.statSync(...args);
      replace();
      return stats;
    },
    fstatSync: (...args: Parameters<typeof original.fstatSync>) => {
      const stats = original.fstatSync(...args);
      replace();
      return stats;
    },
  };
});
vi.mock("../rentals-capability.js", () => ({
  primeRentalFormFactors: () => {},
  getRentalFormFactors: () => [],
}));

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  race.replace = undefined;
  race.closeError = false;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-motis-capabilities-"));
  directories.push(directory);
  const path = join(directory, "capabilities.json");
  const replacementPath = join(directory, "replacement.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, epoch: "epoch-A" }));
  writeFileSync(replacementPath, JSON.stringify({ schemaVersion: 1, epoch: "epoch-B" }));
  vi.stubEnv("MOTIS_CAPABILITY_SNAPSHOT_PATH", path);
  const ctx = createMockIntegrationContext();
  setupLocal(ctx, createTransitMotisInstances({ localUrl: "http://localhost:8080" }));
  return { path, replacementPath, provider: ctx.registered.transit[0] };
}

it("reads the inspected capability generation when its path is replaced during inspection", () => {
  const { path, replacementPath, provider } = fixture();
  race.replace = () => renameSync(replacementPath, path);
  expect(provider?.planningMetadata?.datasetEpoch).toBe("epoch-A");
  expect(provider?.planningMetadata?.datasetEpoch).toBe("epoch-B");
});

it("invalidates the capability cache for a same-size replacement with the same mtime", () => {
  const { path, replacementPath, provider } = fixture();
  const { atime, mtime } = statSync(path);
  utimesSync(path, atime, mtime);
  utimesSync(replacementPath, atime, mtime);
  expect(provider?.planningMetadata?.datasetEpoch).toBe("epoch-A");
  renameSync(replacementPath, path);
  expect(provider?.planningMetadata?.datasetEpoch).toBe("epoch-B");
});

it.each([false, true])(
  "preserves capability lookup fallback despite a close failure (invalid snapshot: %s)",
  (invalid) => {
    const { path, provider } = fixture();
    if (invalid) writeFileSync(path, "invalid snapshot");
    race.closeError = true;
    expect(provider?.planningMetadata?.datasetEpoch).toBe(invalid ? "" : "epoch-A");
  },
);
