import type { FastifyInstance } from "fastify";
import { convertPbfToBz2 } from "./jobs/convert-overpass.js";
import { downloadGtfs, type FeedDescriptor } from "./jobs/download-gtfs.js";
import { downloadOsm } from "./jobs/download-osm.js";
import { downloadStyle } from "./jobs/download-style.js";
import { applyHardlinkPlan, type HardlinkEntry } from "./jobs/link.js";
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

  app.post<{ Body: { region: string } }>("/download/osm", async (req) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    const result = await downloadOsm({ region, dataDir, store });
    return { ok: true, ...result };
  });

  app.post<{ Body: { feeds: FeedDescriptor[]; countries?: string[] } }>(
    "/download/gtfs",
    async (req) => {
      const { feeds, countries = [] } = req.body;
      const downloaded = await downloadGtfs({ feeds, countries, dataDir, store });
      return { ok: true, count: downloaded.length };
    },
  );

  app.post("/download/style", async () => {
    await downloadStyle({ dataDir, store });
    return { ok: true };
  });

  app.post<{ Body: { plan: HardlinkEntry[] } }>("/link", async (req) => {
    const { plan } = req.body;
    const result = await applyHardlinkPlan(plan, { rootDir: dataDir });
    return { ok: true, ...result };
  });

  app.post<{ Body: { sourcePbf: string; targetBz2: string } }>("/convert/overpass", async (req) => {
    await convertPbfToBz2(req.body);
    return { ok: true };
  });
}
