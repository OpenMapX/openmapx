import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogPinSet } from "@openmapx/core/catalog-pins";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createTransitPreflightController,
  normalizeTransitPreflightCountries,
  verifyTransitPreflightBinding,
} from "../../src/jobs/transitous/admin-preflight.js";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});
const pins = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../src/ops-client.js", () => ({ runOpsOperation: async () => pins.value }));
let root: string;
const policy = () => resolveOperationsProfile({ countries: ["de", "at"] });
const makePins = (ref = "a") =>
  createCatalogPinSet(
    {
      ref: `main@${ref.repeat(40)}`,
      submodules: {},
      lockedAt: "2026-10-23T00:00:00.000Z",
      lockedBy: "fixture",
    },
    {
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: "b".repeat(40),
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"b".repeat(40)}/systems.csv`,
      sha256: "c".repeat(64),
      lockedAt: "2026-10-23T00:00:00.000Z",
      lockedBy: "fixture",
    },
  );
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-admin-preflight-"));
  mkdirSync(join(root, ".transitous-catalog/feeds"), { recursive: true });
  writeFileSync(
    join(root, ".transitous-catalog/feeds/de.json"),
    JSON.stringify({
      sources: [
        { name: "catalog", spec: "gtfs", type: "http", url: "https://example.test/feed.zip" },
      ],
    }),
  );
  const active = makePins();
  pins.value = { active, catalogRevisionId: active.generationId };
  for (const [key, value] of Object.entries({
    MOTIS_SLOT_MEMORY_GB: "16",
    MOTIS_SLOT_CPU: "4",
    MOTIS_FILE_DESCRIPTOR_LIMIT: "65536",
    MOTIS_BUILD_TIMEOUT_HOURS: "12",
  }))
    vi.stubEnv(key, value);
  vi.mocked(fs.statfsSync).mockReturnValue({
    bsize: 4096,
    bavail: 2 ** 30,
    ffree: 10 ** 9,
  } as fs.StatsFs);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it("normalizes a checked country subset without accepting empty or unauthorized selections", () => {
  expect(normalizeTransitPreflightCountries(["DE", "de"], policy())).toEqual(["de"]);
  expect(() => normalizeTransitPreflightCountries([], policy())).toThrow(/Select/);
  expect(() => normalizeTransitPreflightCountries(["de", "us"], policy())).toThrow(/scope/);
});
it("derives a bounded preview from actual desired sources, pins and capacity", async () => {
  const controller = createTransitPreflightController({ dataDir: root, policy: policy() });
  const preview = await controller.inspect(["DE", "de"]);
  expect(preview.countries).toEqual(["de"]);
  expect(preview.result.ok).toBe(true);
  expect(preview.result.estimate.feedCount).toBe(1);
  expect(preview.result.capacity.freeDiskBytes).toBe(2 ** 42);
  const binding = await controller.verify({
    countries: ["de"],
    preflightId: preview.preflightId,
    fingerprint: preview.fingerprint,
  });
  await expect(
    verifyTransitPreflightBinding({ dataDir: root, policy: policy() }, ["de"], binding),
  ).resolves.toBeUndefined();
});
it.each(["catalog", "pins", "capacity", "expiry"])(
  "refuses stale %s evidence at admission and worker execution",
  async (change) => {
    const options = { dataDir: root, policy: policy() },
      controller = createTransitPreflightController(options),
      preview = await controller.inspect(["de"]);
    const request = {
        countries: ["de"],
        preflightId: preview.preflightId,
        fingerprint: preview.fingerprint,
      },
      binding = await controller.verify(request);
    if (change === "catalog")
      writeFileSync(
        join(root, ".transitous-catalog/feeds/de.json"),
        JSON.stringify({ sources: [] }),
      );
    if (change === "pins") {
      const active = makePins("d");
      pins.value = { active, catalogRevisionId: active.generationId };
    }
    if (change === "capacity")
      vi.mocked(fs.statfsSync).mockReturnValue({ bsize: 4096, bavail: 1, ffree: 1 } as fs.StatsFs);
    if (change === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
    await expect(controller.verify(request)).rejects.toMatchObject({ code: "preflight_stale" });
    await expect(verifyTransitPreflightBinding(options, ["de"], binding)).rejects.toMatchObject({
      code: "preflight_stale",
    });
  },
);
it("blocks unknown filesystem capacity and rejects invented preview identities", async () => {
  vi.mocked(fs.statfsSync).mockImplementation(() => {
    throw Error("fixture unavailable");
  });
  const controller = createTransitPreflightController({ dataDir: root, policy: policy() }),
    preview = await controller.inspect(["de"]);
  expect(preview.result.ok).toBe(false);
  expect(preview.result.capacity.freeDiskBytes).toBe(0);
  await expect(
    controller.verify({
      countries: ["de"],
      preflightId: preview.preflightId,
      fingerprint: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "preflight_stale" });
});
it("supports a country implied by a finite feed allow-list while retaining the feed constraint", async () => {
  const limited = resolveOperationsProfile({ countries: [], feedAllowList: ["de_catalog"] });
  expect(normalizeTransitPreflightCountries(["DE"], limited)).toEqual(["de"]);
  const preview = await createTransitPreflightController({
    dataDir: root,
    policy: limited,
  }).inspect(["de"]);
  expect(preview.allowedCountries).toEqual(["de"]);
  expect(preview.result.ok).toBe(true);
  expect(() => normalizeTransitPreflightCountries(["at"], limited)).toThrow(/scope/);
});
