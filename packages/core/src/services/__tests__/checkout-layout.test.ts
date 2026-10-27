import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStatePaths, writeAgentStateFile } from "../agent-state";
import { prepareAgentStores } from "../agent-stores";
import { CheckoutRequiredError, checkoutMounted, describeMountLayout } from "../checkout-layout";
import {
  acquireConfigurationOwnership,
  retireLegacyConfigurationWriter,
} from "../configuration-ownership";
import type { ReleaseServiceFiles } from "../release-service-files";
import {
  checkoutPositionFromHistory,
  describeServiceFileImport,
  importCheckoutServiceFiles,
  serviceFilesImported,
} from "../service-file-import";
import { describeServiceFiles } from "../service-file-report";
import { readServiceOverrides } from "../service-overrides";
import { writeLegacyTraefikRoutes } from "../traefik-files";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(join(root, "infra", "docker"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * What the operations agent sees in either layout: the whole checkout, or
 * only infra/docker with its runtime directories at the same paths.
 */
function stack(layout: "checkout" | "narrow") {
  const root = mkdtempSync(join(tmpdir(), `openmapx-layout-${layout}-`));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(agentStatePaths(infraDir).directory, { recursive: true, mode: 0o700 });
  if (layout === "checkout")
    mkdirSync(join(root, "services", "traefik", "config", "dynamic"), { recursive: true });
  return { root, infraDir };
}

const release: ReleaseServiceFiles = {
  origin: "release",
  files: new Map(),
  history: new Map(),
  manifests: new Map(),
  missing: [],
};

describe("the checkout, as the operations agent tells", () => {
  it("is there when its services directory is, and not through a link", () => {
    expect(checkoutMounted(stack("checkout").root)).toBe(true);
    const narrow = stack("narrow");
    expect(checkoutMounted(narrow.root)).toBe(false);
    expect(describeMountLayout(narrow.root)).toMatch(/^The checkout is not mounted: only /);
    symlinkSync(stack("checkout").root, join(narrow.root, "services"));
    expect(checkoutMounted(narrow.root)).toBe(false);
  });

  it("without it, the one-time import waits for a host render, records nothing and says so", () => {
    const { root, infraDir } = stack("narrow");
    expect(checkoutPositionFromHistory(root, release)).toEqual({
      atOrBehindRelease: false,
      reason: expect.stringContaining("runs without the checkout"),
    });
    const result = importCheckoutServiceFiles({ infraDir, services: [], release });
    expect(result).toEqual({ deferred: expect.any(String), pending: [] });
    expect(serviceFilesImported(infraDir)).toBe(false);
    expect(describeServiceFileImport(result)).toEqual([
      expect.stringMatching(
        /^The one-time import of your edits in the checkout's service files has not run, .*run `pnpm openmapx compose render` on the host/,
      ),
    ]);
  });

  it("without it, an import already recorded is said to have run, and nothing is compared", () => {
    const { infraDir } = stack("narrow");
    writeAgentStateFile(
      infraDir,
      "overrides-import.json",
      `${JSON.stringify({ version: 1, importedAt: "2026-10-26T00:00:00Z", imported: [] })}\n`,
    );
    expect(importCheckoutServiceFiles({ infraDir, services: [], release })).toBeNull();
    expect(
      describeServiceFiles({
        infraDir,
        services: [],
        release,
        overrides: readServiceOverrides(infraDir, release),
        stale: [],
      }),
    ).toEqual([expect.stringContaining("runs without the checkout, so it doesn't compare")]);
  });

  it("without it, stores never copied from it are refused, not recorded as empty", () => {
    const { infraDir } = stack("narrow");
    expect(() => prepareAgentStores(infraDir)).toThrow(CheckoutRequiredError);
    expect(() => prepareAgentStores(infraDir)).toThrow(
      /stores were never copied from the checkout/,
    );
    expect(existsSync(agentStatePaths(infraDir).storesMigration)).toBe(false);
    // Copied once, from the checkout: then nothing needs it.
    const withCheckout = stack("checkout");
    expect(prepareAgentStores(withCheckout.infraDir)).not.toBeNull();
    rmSync(join(withCheckout.root, "services"), { recursive: true });
    expect(prepareAgentStores(withCheckout.infraDir)).toBeNull();
  });

  it("without it, routes a Traefik still reads from the checkout are reported as unreachable", () => {
    const narrow = stack("narrow");
    expect(writeLegacyTraefikRoutes(narrow.infraDir, "http: {}\n", true)).toMatch(
      /^The routes could not be written to services\/traefik\/config\/dynamic, .*: this operations agent runs without the checkout\./,
    );
    expect(writeLegacyTraefikRoutes(narrow.infraDir, "http: {}\n", undefined)).toBeNull();
    const checkout = stack("checkout");
    expect(writeLegacyTraefikRoutes(checkout.infraDir, "http: {}\n", true)).toBeNull();
  });

  it("without it, a writer that still takes the earlier lock in a read-only infra/docker says why", async () => {
    const { infraDir } = stack("narrow");
    chmodSync(infraDir, 0o555);
    const refused = acquireConfigurationOwnership(infraDir);
    await expect(refused).rejects.toThrow(CheckoutRequiredError);
    await expect(acquireConfigurationOwnership(infraDir)).rejects.toThrow(
      /legacy-configuration-writer-retired\.json is missing/,
    );
    // Once retired, only the lock in the agent's state is taken.
    retireLegacyConfigurationWriter(infraDir);
    const release = await acquireConfigurationOwnership(infraDir);
    release();
  });
});
