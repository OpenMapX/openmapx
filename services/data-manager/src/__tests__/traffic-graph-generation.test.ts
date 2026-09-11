import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTrafficGraphGeneration,
  readTrafficGraphState,
} from "../jobs/traffic/graph-generation.js";

describe("traffic graph generation", () => {
  it("requires one activated graph/extract/map generation and invalidates engine restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "traffic-generation-"));
    try {
      await expect(readTrafficGraphGeneration(dir)).rejects.toThrow();
      const generation = {
        schemaVersion: 1,
        graphGeneration: "g1",
        extractGeneration: "g1",
        waysToEdgesGeneration: "g1",
      };
      await writeFile(join(dir, "traffic-generations.json"), JSON.stringify(generation));
      await writeFile(
        join(dir, "traffic-engine.json"),
        JSON.stringify({ schemaVersion: 1, bootId: "boot1" }),
      );
      const before = await readTrafficGraphGeneration(dir);
      expect(await readTrafficGraphState(dir)).toEqual({
        generation: before,
        engineBootId: "boot1",
      });
      await writeFile(
        join(dir, "traffic-engine.json"),
        JSON.stringify({ schemaVersion: 1, bootId: "boot2" }),
      );
      expect(await readTrafficGraphGeneration(dir)).not.toBe(before);
      await writeFile(
        join(dir, "traffic-generations.json"),
        JSON.stringify({ ...generation, extractGeneration: "old" }),
      );
      await expect(readTrafficGraphGeneration(dir)).rejects.toThrow(/inconsistent/);
      await writeFile(join(dir, ".traffic-maintenance.json"), "{}");
      await expect(readTrafficGraphGeneration(dir)).rejects.toThrow(/maintenance/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
