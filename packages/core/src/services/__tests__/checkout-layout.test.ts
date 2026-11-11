import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStatePaths } from "../agent-state";
import { prepareAgentStores } from "../agent-stores";
import { checkoutMounted } from "../checkout-layout";
import { acquireConfigurationOwnership } from "../configuration-ownership";
import { writeLegacyTraefikRoutes } from "../traefik-files";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(join(root, "infra", "docker"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * What a process sees: the host CLI's whole checkout, or the operations
 * agent's mounts, only infra/docker with its runtime directories at the same
 * paths.
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

describe("the checkout, as the operations agent tells", () => {
  it("is there when its services directory is, and not through a link", () => {
    expect(checkoutMounted(stack("checkout").root)).toBe(true);
    const narrow = stack("narrow");
    expect(checkoutMounted(narrow.root)).toBe(false);
    symlinkSync(stack("checkout").root, join(narrow.root, "services"));
    expect(checkoutMounted(narrow.root)).toBe(false);
  });

  it("without it, the agent's stores start empty and owner-only, and a link is refused", () => {
    const { infraDir } = stack("narrow");
    const paths = agentStatePaths(infraDir);
    prepareAgentStores(infraDir);
    chmodSync(paths.community, 0o755);
    prepareAgentStores(infraDir);
    for (const store of [paths.community, paths.customIntegrations]) {
      expect(readdirSync(store)).toEqual([]);
      expect(statSync(store).mode & 0o777).toBe(0o700);
    }
    rmSync(paths.customIntegrations, { recursive: true });
    symlinkSync(stack("narrow").root, paths.customIntegrations);
    expect(() => prepareAgentStores(infraDir)).toThrow(/is not its own directory/);
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

  it("without it, a writer takes only the lock in the agent's state, so a read-only infra/docker is no obstacle", async () => {
    const { infraDir } = stack("narrow");
    chmodSync(infraDir, 0o555);
    const release = await acquireConfigurationOwnership(infraDir);
    release();
  });
});
