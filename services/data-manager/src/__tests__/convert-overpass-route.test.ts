import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerApi } from "../api.js";

function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), "openmapx-convert-overpass-route-"));
}

describe("POST /convert/overpass", () => {
  it("rejects the legacy explicit-path form before touching the requested target", async () => {
    const dataDir = makeDataDir();
    const sourcePbf = join(dataDir, "source.osm.pbf");
    const targetDir = join(dataDir, "caller-selected");
    writeFileSync(sourcePbf, "not an OSM PBF", "utf8");
    const app = Fastify();
    registerApi(app, { dataDir });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/convert/overpass",
        payload: { sourcePbf, targetBz2: join(targetDir, "data.osm.bz2") },
      });

      expect(response.statusCode).toBe(400);
      expect(existsSync(targetDir)).toBe(false);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["sourcePbf", { sourcePbf: "/tmp/source.osm.pbf" }],
    ["targetBz2", { targetBz2: "/tmp/target.osm.bz2" }],
    ["an unrelated property", { extra: true }],
  ])("rejects %s instead of silently discarding it", async (_label, payload) => {
    const dataDir = makeDataDir();
    const app = Fastify();
    registerApi(app, { dataDir });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/convert/overpass",
        payload,
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each([{}, { region: "europe/germany" }])(
    "requires the assembled durable receiver for the region-based form %j",
    async (payload) => {
      const dataDir = makeDataDir();
      const app = Fastify();
      registerApi(app, { dataDir });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/convert/overpass",
          payload,
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          error: "Service Unavailable",
          message: "Durable data receiver is unavailable",
        });
        expect(existsSync(join(dataDir, "overpass"))).toBe(false);
      } finally {
        await app.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});
