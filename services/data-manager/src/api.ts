import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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

  app.post("/datasets/reload", async () => {
    const result = store.reload();
    return { ok: true, ...result };
  });

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
  }>("/download/gtfs", async (req, reply) => {
    const { feeds, countries = [], source } = req.body;
    if (Array.isArray(feeds) && feeds.length === 0 && source !== "transitous") {
      throw new Error("download/gtfs: either `feeds` or `source: 'transitous'` is required");
    }

    // Long-running GTFS refreshes can exceed default client header/body
    // timeouts. Stream keepalive whitespace while the import is running.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });

    const keepalive = setInterval(() => {
      try {
        reply.raw.write(" \n");
      } catch {
        // Ignore broken pipe errors if the client disconnected.
      }
    }, 10_000);

    const useTransitousPipeline = source === "transitous" || feeds === undefined;
    try {
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
      reply.raw.end(
        JSON.stringify({
          ok: result.failures.length === 0,
          count: result.downloaded.length,
          usedTransitousPipeline: useTransitousPipeline,
          requestedCount: result.requestedCount,
          selectedCount: result.selectedCount,
          skippedCount: result.skippedCount,
          failedCount: result.failures.length,
          partialSuccess: result.partialSuccess,
          failures: result.failures,
        }),
      );
    } catch (err) {
      reply.raw.end(
        JSON.stringify({
          ok: false,
          count: 0,
          usedTransitousPipeline: useTransitousPipeline,
          requestedCount: 0,
          selectedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          partialSuccess: false,
          failures: [],
          error: (err as Error).message,
        }),
      );
    } finally {
      clearInterval(keepalive);
    }
  });

  app.post("/download/style", async () => {
    await downloadStyle({ dataDir, store });
    return { ok: true };
  });

  app.delete<{ Params: { slug: string } }>("/datasets/gtfs/:slug", async (req, reply) => {
    const slug = req.params.slug.trim();
    if (!slug || slug.includes("/") || slug.includes("..")) {
      reply.code(400);
      return { ok: false, error: "invalid slug" };
    }
    const gtfsDir = join(dataDir, "gtfs");
    if (!existsSync(gtfsDir)) {
      reply.code(404);
      return { ok: false, error: "gtfs dir does not exist" };
    }
    // Match `<slug>.gtfs.zip`, `<slug>.netex.zip`, or bare `<slug>.zip`.
    const removed: string[] = [];
    for (const name of readdirSync(gtfsDir)) {
      if (name === `${slug}.gtfs.zip` || name === `${slug}.netex.zip` || name === `${slug}.zip`) {
        rmSync(join(gtfsDir, name), { force: true });
        removed.push(name);
      }
    }
    if (removed.length === 0) {
      reply.code(404);
      return { ok: false, error: `no GTFS feed matched slug "${slug}"` };
    }
    store.remove("gtfs", slug);
    return { ok: true, removed };
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
