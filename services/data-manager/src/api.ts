import type { FastifyInstance } from "fastify";
import { convertPbfToBz2, convertPbfToBz2ForRegion } from "./jobs/convert-overpass.js";
import { downloadGtfs, type FeedDescriptor } from "./jobs/download-gtfs.js";
import { downloadOsm } from "./jobs/download-osm.js";
import { downloadStyle } from "./jobs/download-style.js";
import { applyHardlinkPlan, type HardlinkEntry } from "./jobs/link.js";
import { downloadGtfsViaTransitous } from "./jobs/transitous-pipeline.js";
import { StateStore } from "./state.js";

export interface ApiOptions {
  dataDir?: string;
}

const startedAt = Date.now();

export function registerApi(app: FastifyInstance, opts: ApiOptions = {}): void {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "/data";
  const store = new StateStore(dataDir);

  app.get("/status", async () => ({
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    dataDir,
  }));

  app.get("/datasets", async () => ({ datasets: store.getAll() }));

  app.post<{ Body: { region: string } }>("/download/osm", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");

    // Stream NDJSON progress events back to the client. Hijacking the reply
    // lets us write line-by-line; Fastify otherwise buffers the full body.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    const writeLine = (obj: Record<string, unknown>) => {
      reply.raw.write(`${JSON.stringify(obj)}\n`);
    };

    try {
      const result = await downloadOsm({
        region,
        dataDir,
        store,
        onProgress: (bytes, totalBytes) => writeLine({ event: "progress", bytes, totalBytes }),
      });
      writeLine({ event: "done", ok: true, ...result });
    } catch (err) {
      writeLine({ event: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });

  app.post<{
    Body: { feeds?: FeedDescriptor[]; countries?: string[]; source?: "transitous" };
  }>("/download/gtfs", async (req) => {
    const { feeds, countries = [], source } = req.body;
    if (Array.isArray(feeds) && feeds.length === 0 && source !== "transitous") {
      throw new Error("download/gtfs: either `feeds` or `source: 'transitous'` is required");
    }
    const useTransitousPipeline = source === "transitous" || feeds === undefined;
    const result = useTransitousPipeline
      ? await downloadGtfsViaTransitous({
          countries,
          dataDir,
          store,
        })
      : await downloadGtfs({
          feeds,
          countries,
          dataDir,
          store,
        });
    return {
      ok: result.failures.length === 0,
      count: result.downloaded.length,
      usedTransitousPipeline: useTransitousPipeline,
      requestedCount: result.requestedCount,
      selectedCount: result.selectedCount,
      skippedCount: result.skippedCount,
      failedCount: result.failures.length,
      partialSuccess: result.partialSuccess,
      failures: result.failures,
    };
  });

  app.post("/download/style", async () => {
    await downloadStyle({ dataDir, store });
    return { ok: true };
  });

  app.post<{ Body: { plan: HardlinkEntry[]; prune?: boolean } }>("/link", async (req) => {
    const { plan, prune } = req.body;
    const result = await applyHardlinkPlan(plan, { rootDir: dataDir, prune });
    return { ok: true, ...result };
  });

  app.post<{ Body: { sourcePbf?: string; targetBz2?: string; region?: string } }>(
    "/convert/overpass",
    async (req, reply) => {
      const { sourcePbf, targetBz2, region } = req.body ?? {};

      // Low-level form: caller supplied explicit paths. Run the raw conversion
      // and return a simple JSON result (no streaming — legacy behaviour).
      if (sourcePbf && targetBz2) {
        await convertPbfToBz2({ sourcePbf, targetBz2 });
        return { ok: true };
      }

      // High-level form: stream NDJSON progress and pick source/target from
      // the state store. Mirrors the /download/osm streaming protocol so the
      // CLI can reuse the same progress renderer.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      });
      const writeLine = (obj: Record<string, unknown>) => {
        reply.raw.write(`${JSON.stringify(obj)}\n`);
      };

      try {
        const result = await convertPbfToBz2ForRegion({
          region,
          dataDir,
          store,
          onProgress: (bytes, totalBytes) => writeLine({ event: "progress", bytes, totalBytes }),
        });
        writeLine({ event: "done", ok: true, ...result });
      } catch (err) {
        writeLine({ event: "error", message: (err as Error).message });
      } finally {
        reply.raw.end();
      }
    },
  );
}
