import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRuntimeBundle, RUNTIME_BUNDLES } from "./build-runtime-bundles.mjs";

const ROOT = resolve(import.meta.dirname, "..");
let files: Map<string, Uint8Array> = new Map();

beforeAll(async () => {
  files = (await buildRuntimeBundle(ROOT, "ops-agent", RUNTIME_BUNDLES["ops-agent"])).files;
}, 120_000);

const text = (name: string) => Buffer.from(files.get(name) ?? []).toString("utf8");

describe("the ops-agent bundle's catalog pins", () => {
  it.each(["gbfs-catalog.lock.json", "transitous.lock.json"])(
    "carries the release's %s and reads nothing else by that name",
    (name) => {
      const pattern = new RegExp(`^assets/[a-f0-9]{12}-${name.replaceAll(".", "\\.")}$`);
      const assets = [...files.keys()].filter((file) => pattern.test(file));
      expect(assets).toHaveLength(1);
      const [asset] = assets as [string];
      expect(Buffer.from(files.get(asset) ?? []).toString("utf8")).toBe(
        readFileSync(join(ROOT, "infra", "docker", name), "utf8"),
      );
      // Every mention of the file in the agent's and the CLI's code is the asset.
      const mention = new RegExp(`[^"'\`\\s]*${name.replaceAll(".", "\\.")}`, "g");
      for (const entry of ["agent.mjs", "cli.mjs"]) {
        const mentions = text(entry).match(mention) ?? [];
        expect(
          mentions.filter((found) => found !== `./${asset}`),
          entry,
        ).toEqual([]);
      }
    },
  );

  it("reads no Transitous proposal from the checkout", () => {
    for (const entry of ["agent.mjs", "cli.mjs"]) {
      expect(text(entry), entry).not.toContain("transitous.lock.proposed.json");
    }
  });
});
