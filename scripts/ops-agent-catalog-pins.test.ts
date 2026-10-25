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
  it("carries the release's GBFS registry pin and reads nothing else by that name", () => {
    const assets = [...files.keys()].filter((name) =>
      /^assets\/[a-f0-9]{12}-gbfs-catalog\.lock\.json$/.test(name),
    );
    expect(assets).toHaveLength(1);
    const [asset] = assets as [string];
    expect(Buffer.from(files.get(asset) ?? []).toString("utf8")).toBe(
      readFileSync(join(ROOT, "infra", "docker", "gbfs-catalog.lock.json"), "utf8"),
    );
    // Every mention of the file in the agent's and the CLI's code is the asset.
    for (const entry of ["agent.mjs", "cli.mjs"]) {
      const mentions = text(entry).match(/[^"'`\s]*gbfs-catalog\.lock\.json/g) ?? [];
      expect(
        mentions.filter((mention) => mention !== `./${asset}`),
        entry,
      ).toEqual([]);
    }
  });
});
