import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDataInventory } from "./data-inventory";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A checkout as `git clone` leaves it under a umask of 002: its own
 * directories group-writable. The data directory is created by the stack
 * (owner-only), and the services' outputs inside it by data-manager.
 */
function umask002Checkout(): { root: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), "openmapx-inventory-"));
  roots.push(root);
  const data = join(root, "infra", "docker", "data");
  mkdirSync(join(data, "osm"), { recursive: true });
  mkdirSync(join(data, "valhalla"));
  mkdirSync(join(data, "motis", "live"), { recursive: true });
  writeFileSync(join(data, "osm", "germany-latest.osm.pbf"), "pbf");
  writeFileSync(
    join(data, "motis", "slot-state.json"),
    JSON.stringify({ activeSlot: "B", previousHealthySlot: "A" }),
  );
  writeFileSync(join(root, "infra", "docker", "transitous.lock.proposed.json"), "{}");
  // data-manager writes the data directory's contents with a umask of 022.
  for (const path of ["osm", "valhalla", "motis", join("motis", "live")]) {
    chmodSync(join(data, path), 0o755);
  }
  for (const path of [join("osm", "germany-latest.osm.pbf"), join("motis", "slot-state.json")]) {
    chmodSync(join(data, path), 0o644);
  }
  for (const path of [root, join(root, "infra")]) chmodSync(path, 0o775);
  // Rendering takes group and other write off infra/docker, which holds the
  // stack's pointers; the agent only runs after a render.
  chmodSync(join(root, "infra", "docker"), 0o755);
  chmodSync(data, 0o700);
  return { root, data };
}

describe("data inventory", () => {
  // Every read is descriptor-anchored through /proc/self/fd.
  it.runIf(process.platform === "linux")(
    "reads a checkout whose own directories a umask of 002 left group-writable",
    async () => {
      const { root } = umask002Checkout();
      const inventory = await inspectDataInventory(root);
      expect(inventory.osm).toMatchObject({ found: true, filename: "germany-latest.osm.pbf" });
      expect(inventory.builds).toContainEqual(
        expect.objectContaining({ target: "valhalla", built: true }),
      );
      expect(inventory.motisTransitous).toMatchObject({
        activeSlot: "B",
        previousHealthySlot: "A",
        pinProposalPending: true,
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "does not read through a data directory others can write",
    async () => {
      const { root, data } = umask002Checkout();
      chmodSync(data, 0o777);
      const inventory = await inspectDataInventory(root);
      expect(inventory.osm).toEqual({ found: false });
      expect(inventory.motisTransitous).toMatchObject({ activeSlot: null });
    },
  );
});
