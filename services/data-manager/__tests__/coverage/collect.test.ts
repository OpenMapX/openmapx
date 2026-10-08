import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { collectCoverageSnapshot } from "../../src/coverage/collect.js";
import { StateStore } from "../../src/state.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function emptySql() {
  const unsafe = vi.fn(async (query: string) => {
    if (query.includes("to_regclass('osm_search.index_state')")) return [{ exists: false }];
    if (query.includes("to_regclass('overture_places.conflation_state')"))
      return [{ exists: false }];
    if (query.includes("data_manager.feed_state")) return [];
    throw new Error(`unexpected SQL in fixture: ${query}`);
  });
  return { unsafe } as unknown as postgres.Sql;
}

describe("data-manager coverage collection", () => {
  it("isolates a malformed active transit manifest from the other evidence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-coverage-manifest-"));
    try {
      mkdirSync(join(dataDir, "motis/slots/A"), { recursive: true });
      writeFileSync(
        join(dataDir, "motis/slot-state.json"),
        JSON.stringify({ schemaVersion: 1, activeSlot: "A", datasetEpoch: "epoch" }),
      );
      writeFileSync(
        join(dataDir, "motis/slots/A/transit-source-manifest.json"),
        JSON.stringify({ version: 1, generatedAt: NOW.toISOString(), sources: [{ artifact: {} }] }),
      );
      const result = await collectCoverageSnapshot({
        dataDir,
        sql: emptySql(),
        store: new StateStore(dataDir),
        now: () => NOW,
      });
      expect(result.collectionStatus).toBe("partial");
      expect(result.streams).toHaveLength(6);
      expect(result.streams.find((stream) => stream.domain === "transit")?.presence).toBe(
        "unknown",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps an empty deployment distinct from missing optional publication schemas", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-coverage-empty-"));
    try {
      const result = await collectCoverageSnapshot({
        dataDir,
        sql: emptySql(),
        store: new StateStore(dataDir),
        now: () => NOW,
      });

      expect(result.collectionStatus).toBe("complete");
      expect(result.streams.map((stream) => stream.key)).toEqual([
        "service:data-manager:osm-search",
        "service:data-manager:overture-places",
        "transit:active-runtime",
        "traffic:flow",
        "traffic:conditions",
        "traffic:graph",
      ]);
      expect(
        result.streams.find((stream) => stream.key === "service:data-manager:osm-search")?.reasons,
      ).toEqual(expect.arrayContaining(["schema_unavailable", "no_publication_evidence"]));
      expect(result.unassignedSourceCount).toBe(6);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("surfaces corrupt inventory as partial instead of treating it as valid empty", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-coverage-corrupt-"));
    try {
      writeFileSync(join(dataDir, ".data-manager-state.json"), "{not-json", "utf8");
      const result = await collectCoverageSnapshot({
        dataDir,
        sql: emptySql(),
        store: new StateStore(dataDir),
        now: () => NOW,
      });
      expect(result.collectionStatus).toBe("partial");
      expect(result.warnings).toContain("collector_unavailable");
      expect(result.authorities).toContainEqual(
        expect.objectContaining({ authority: "data-manager", status: "partial" }),
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("surfaces structurally invalid inventory entries as corrupt", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openmapx-coverage-invalid-entry-"));
    try {
      writeFileSync(
        join(dataDir, ".data-manager-state.json"),
        JSON.stringify({ datasets: [{}] }),
        "utf8",
      );
      const store = new StateStore(dataDir);
      expect(store.getLoadDiagnostics()).toMatchObject({ status: "corrupt" });
      expect(store.getAll()).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
