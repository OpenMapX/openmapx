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
  it.each(["transitous.lock.json"])("embeds the release's immutable %s baseline", (name) => {
    const pattern = new RegExp(`^assets/[a-f0-9]{12}-${name.replaceAll(".", "\\.")}$`);
    const assets = [...files.keys()].filter((file) => pattern.test(file));
    expect(assets).toHaveLength(1);
    const [asset] = assets as [string];
    expect(Buffer.from(files.get(asset) ?? []).toString("utf8")).toBe(
      readFileSync(join(ROOT, "infra", "docker", name), "utf8"),
    );

    // Paired-pin management intentionally retains fixed compatibility import
    // paths. Runtime consumers still receive this immutable release baseline;
    // activation and proposal isolation are covered by the actual catalog store.
    for (const entry of ["agent.mjs"]) expect(text(entry), entry).toContain(`./${asset}`);
  });

  it("omits unused GBFS release files when consumers read the managed pair", () => {
    expect([...files.keys()].filter((name) => name.endsWith("-gbfs-catalog.lock.json"))).toEqual(
      [],
    );
    expect(text("cli.mjs")).toContain("catalogPins.inspect");
  });

  it("packages no mutable checkout proposal as a release asset", () => {
    expect([...files.keys()].filter((name) => name.includes("transitous.lock.proposed"))).toEqual(
      [],
    );
    const runtime = readFileSync(
      join(ROOT, "apps/ops-agent/src/transitous-lock-runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain("readCatalogPinSet");
    expect(runtime).toContain("retainCatalogProposal");
  });
});
