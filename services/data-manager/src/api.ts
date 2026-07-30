import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { feedState } from "@openmapx/db-schema";
import { parseTransitSource } from "@openmapx/transitous-core";
import { execa } from "execa";
import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "./db/index.js";
import { convertPbfToBz2, convertPbfToBz2ForRegion } from "./jobs/convert-overpass.js";
import { downloadGtfs, type FeedDescriptor } from "./jobs/download-gtfs.js";
import { downloadOsm } from "./jobs/download-osm.js";
import { downloadStyle } from "./jobs/download-style.js";
import { applyHardlinkPlan, type HardlinkEntry } from "./jobs/link.js";
import { extractOsmPois } from "./jobs/overture/extract-osm-pois.js";
import { ingestOverture } from "./jobs/overture/ingest.js";
import { withOvertureOperationLock } from "./jobs/overture/operation-lock.js";
import { assertValidRegion, pullOverture } from "./jobs/overture/pull.js";
import { getOvertureConflationState, rebuildOvertureLinks } from "./jobs/overture/rebuild-links.js";
import { syncOvertureRegion } from "./jobs/overture/sync.js";
import {
  CatalogBumpError,
  candidateMatchesLock,
  lockFromCandidate,
  resolveCatalogBumpCandidate,
} from "./jobs/transitous/catalog-bump.js";
import {
  buildJobContext,
  runTransitousPipeline,
  toDownloadGtfsResult,
} from "./jobs/transitous/index.js";
import { PRIMARY_CONTAINER } from "./jobs/transitous/motis-containers.js";
import {
  type MotisOperationsPolicy,
  publicOperationsPolicy,
  resolveOperationsProfileFromEnv,
} from "./jobs/transitous/operations-profile.js";
import { finalizeJobRow, makePersistingOnStageComplete } from "./jobs/transitous/persistence.js";
import { runMotisPreflight } from "./jobs/transitous/preflight.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
import { asJobLogger, jobChildLogger } from "./logger.js";
import { StateStore } from "./state.js";
import {
  listPinnedTransitCatalog,
  listTransitSources,
  prepareAddTransitSource,
  prepareEnableTransitSource,
  prepareRemoveTransitSource,
  resolveTransitOverlayPath,
  TransitSourceError,
  type TransitSourceLifecycle,
} from "./transit-sources.js";
import {
  readTransitousLock,
  readTransitousLockProposal,
  type TransitousLock,
  writeTransitousLock,
  writeTransitousLockProposal,
} from "./transitous-lock.js";

export interface ApiOptions {
  dataDir?: string;
  /** Repo root used by `/transit/bump` to locate `infra/docker/transitous.lock.json`. */
  repoRoot?: string;
  /**
   * Single-flight controller. Defaults to the process-wide singleton so the
   * cron + `/transit/sync` share state; tests inject an isolated controller.
   */
  singleFlight?: SingleFlightController;
  operationsPolicy?: MotisOperationsPolicy;
  /** Test seam invoked after reservation; production launches the real pipeline. */
  launchTransitSync?: (args: { jobId: string; countries: string[]; trigger: string }) => void;
}

const startedAt = Date.now();

// Conservative git ref-name shape. Blocks option injection (leading "-"),
// path traversal ("..") and refspec magic ("@{", "~", "^", ":", whitespace,
// control chars) while allowing the slugs/branches the catalog actually uses
// (e.g. "main", "release/2026-06", "feature/x-y").
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isSafeGitRef(ref: string): boolean {
  return (
    SAFE_GIT_REF.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock")
  );
}

interface NdjsonStream {
  writeLine: (obj: Record<string, unknown>) => void;
  end: () => void;
}

/**
 * Opens a long-lived NDJSON response and keeps it active across quiet database
 * stages. Undici terminates a response body after roughly five minutes with no
 * bytes; country-scale Overture H3/index work can legitimately be silent for
 * longer than that. Safe writes also let the server-side operation finish if a
 * client disconnects for an unrelated reason.
 */
function openNdjsonStream(reply: FastifyReply): NdjsonStream {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  const write = (chunk: string): void => {
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    try {
      reply.raw.write(chunk);
    } catch {
      // The operation is independently durable; a disconnected observer must
      // not abort a schema swap or leave a completed staging build unpublished.
    }
  };
  const keepalive = setInterval(() => write(" \n"), 10_000);
  keepalive.unref();

  return {
    writeLine: (obj) => write(`${JSON.stringify(obj)}\n`),
    end: () => {
      clearInterval(keepalive);
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.end();
      } catch {
        // Client already disconnected.
      }
    },
  };
}

export function registerApi(app: FastifyInstance, opts: ApiOptions = {}): void {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "/data";
  const repoRoot = opts.repoRoot ?? process.env.OPENMAPX_ROOT_DIR ?? "";
  const singleFlight = opts.singleFlight ?? getSingleFlightController();
  const store = new StateStore(dataDir);
  const operationsPolicy =
    opts.operationsPolicy ??
    resolveOperationsProfileFromEnv(process.env, { allowEmptyRegional: true });
  const catalogDir = join(dataDir, ".transitous-catalog");
  const overlayPath = resolveTransitOverlayPath(dataDir);

  function launchReservedTransitSync(jobId: string, countries: string[], trigger: string): void {
    if (opts.launchTransitSync) {
      opts.launchTransitSync({ jobId, countries, trigger });
      return;
    }
    const jobLog = asJobLogger(jobChildLogger({ job: "transitous-sync", jobId, trigger }));
    const persistingHook = makePersistingOnStageComplete(jobId, jobLog);
    void (async () => {
      try {
        const ctx = buildJobContext({
          dataDir,
          store,
          countries,
          repoRoot,
          source: parseTransitSource(),
          operationsPolicy: { ...operationsPolicy, countries },
          jobId,
          logger: jobLog,
          onStageComplete: persistingHook,
          feedsOverlayPath: overlayPath,
        });
        const result = await runTransitousPipeline(ctx);
        await finalizeJobRow(jobId, result.finalStatus);
        app.log.info({ jobId, finalStatus: result.finalStatus }, "transitous-api: sync finished");
      } catch (err) {
        app.log.error({ jobId, err }, "transitous-api: sync threw");
        try {
          await finalizeJobRow(jobId, "error");
        } catch {
          // The row remains visible as running if Postgres itself is unavailable.
        }
      } finally {
        singleFlight.markSyncFinished();
      }
    })();
  }

  async function reserveSourceMutation(options: {
    triggeredBy: string;
    idempotencyKey?: string;
    sourceId: string;
    action: "add" | "remove" | "enable";
    persist: () => void;
  }): Promise<
    { ok: true; jobId: string } | { ok: false; status: number; body: Record<string, unknown> }
  > {
    const start = await singleFlight.tryStartSync({
      trigger: "api",
      triggeredBy: options.triggeredBy,
      idempotencyKey: options.idempotencyKey,
      kind: "transitous-sync",
      metadata: {
        source: "source-mutation",
        action: options.action,
        sourceId: options.sourceId,
        countries: operationsPolicy.countries,
      },
    });
    if (!start.ok) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          reason: start.reason,
          existingJobId: start.existingJobId,
        },
      };
    }
    try {
      // The synchronous single-flight reservation and visible job row exist
      // before the atomic desired-state rename.
      options.persist();
    } catch (error) {
      await finalizeJobRow(start.jobId, "error");
      singleFlight.markSyncFinished();
      return {
        ok: false,
        status: 500,
        body: { ok: false, error: (error as Error).message, jobId: start.jobId },
      };
    }
    launchReservedTransitSync(start.jobId, operationsPolicy.countries, `source-${options.action}`);
    return { ok: true, jobId: start.jobId };
  }

  app.get("/status", async () => ({
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    dataDir,
  }));

  app.get("/datasets", async () => ({ datasets: store.getAll() }));

  app.get("/transit/profile", async () => ({ policy: publicOperationsPolicy(operationsPolicy) }));

  app.get<{
    Querystring: {
      search?: string;
      lifecycle?: TransitSourceLifecycle;
      origin?: "catalog" | "operator";
      limit?: string;
      offset?: string;
    };
  }>("/transit/sources", async (req, reply) => {
    try {
      const feedStates = await db.select().from(feedState);
      return listTransitSources({
        dataDir,
        catalogDir,
        overlayPath,
        feedStates,
        query: {
          search: req.query.search,
          lifecycle: req.query.lifecycle,
          origin: req.query.origin,
          limit: Number(req.query.limit ?? 100),
          offset: Number(req.query.offset ?? 0),
        },
      });
    } catch (error) {
      const status = error instanceof TransitSourceError ? error.statusCode : 500;
      return reply.code(status).send({ ok: false, error: (error as Error).message });
    }
  });

  app.get("/transit/catalog", async (_req, reply) => {
    try {
      return { sources: listPinnedTransitCatalog(catalogDir) };
    } catch (error) {
      const status = error instanceof TransitSourceError ? error.statusCode : 500;
      return reply.code(status).send({ ok: false, error: (error as Error).message });
    }
  });

  app.post<{
    Body: {
      region: string;
      name: string;
      url: string;
      license: {
        spdxIdentifier?: string;
        url?: string;
        attribution: string;
        publisher?: string;
        publisherUrl?: string;
      };
      idempotencyKey?: string;
      triggeredBy?: string;
    };
  }>("/transit/sources", async (req, reply) => {
    let mutation: ReturnType<typeof prepareAddTransitSource>;
    try {
      mutation = prepareAddTransitSource({
        catalogDir,
        overlayPath,
        source: {
          spec: "gtfs",
          type: "http",
          region: req.body.region,
          name: req.body.name,
          url: req.body.url,
          origin: "operator",
          license: req.body.license,
        },
      });
    } catch (error) {
      const status = error instanceof TransitSourceError ? error.statusCode : 400;
      return reply.code(status).send({ ok: false, error: (error as Error).message });
    }
    const result = await reserveSourceMutation({
      triggeredBy: req.body.triggeredBy ?? "api",
      idempotencyKey: req.body.idempotencyKey,
      sourceId: mutation.sourceId,
      action: "add",
      persist: mutation.persist,
    });
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply
      .code(202)
      .send({ jobId: result.jobId, sourceId: mutation.sourceId, status: "started" });
  });

  app.delete<{
    Params: { sourceId: string };
    Body?: { idempotencyKey?: string; triggeredBy?: string };
  }>("/transit/sources/:sourceId", async (req, reply) => {
    let mutation: ReturnType<typeof prepareRemoveTransitSource>;
    try {
      mutation = prepareRemoveTransitSource({
        catalogDir,
        overlayPath,
        sourceId: req.params.sourceId,
      });
    } catch (error) {
      const status = error instanceof TransitSourceError ? error.statusCode : 400;
      return reply.code(status).send({ ok: false, error: (error as Error).message });
    }
    const result = await reserveSourceMutation({
      triggeredBy: req.body?.triggeredBy ?? "api",
      idempotencyKey: req.body?.idempotencyKey,
      sourceId: mutation.sourceId,
      action: "remove",
      persist: mutation.persist,
    });
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply
      .code(202)
      .send({ jobId: result.jobId, sourceId: mutation.sourceId, status: "started" });
  });

  app.post<{
    Params: { sourceId: string };
    Body?: { idempotencyKey?: string; triggeredBy?: string };
  }>("/transit/sources/:sourceId/enable", async (req, reply) => {
    let mutation: ReturnType<typeof prepareEnableTransitSource>;
    try {
      mutation = prepareEnableTransitSource({
        catalogDir,
        overlayPath,
        sourceId: req.params.sourceId,
      });
    } catch (error) {
      const status = error instanceof TransitSourceError ? error.statusCode : 400;
      return reply.code(status).send({ ok: false, error: (error as Error).message });
    }
    const result = await reserveSourceMutation({
      triggeredBy: req.body?.triggeredBy ?? "api",
      idempotencyKey: req.body?.idempotencyKey,
      sourceId: mutation.sourceId,
      action: "enable",
      persist: mutation.persist,
    });
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply
      .code(202)
      .send({ jobId: result.jobId, sourceId: mutation.sourceId, status: "started" });
  });

  app.post<{
    Body?: {
      feedCount?: number;
      measuredCompressedBytes?: number;
      osmBytes?: number;
      osmAvailable?: boolean;
      freeDiskBytes?: number;
      freeInodes?: number;
      slotMemoryGb?: number;
      slotCpu?: number;
      fileDescriptorLimit?: number;
      buildTimeoutHours?: number;
    };
  }>("/transit/preflight", async (req, reply) => {
    const body = req.body ?? {};
    const result = runMotisPreflight({
      policy: operationsPolicy,
      feedCount: Math.max(0, Math.floor(body.feedCount ?? 0)),
      measuredCompressedBytes: body.measuredCompressedBytes,
      osmBytes: body.osmBytes,
      osmAvailable: body.osmAvailable === true,
      capacity: {
        freeDiskBytes: body.freeDiskBytes ?? 0,
        freeInodes: body.freeInodes,
        slotMemoryGb: body.slotMemoryGb ?? 0,
        slotCpu: body.slotCpu ?? 0,
        fileDescriptorLimit: body.fileDescriptorLimit ?? 0,
        buildTimeoutHours: body.buildTimeoutHours ?? 0,
      },
    });
    if (!result.ok) reply.code(422);
    return result;
  });

  app.post("/datasets/reload", async () => {
    const result = store.reload();
    return { ok: true, ...result };
  });

  app.post<{ Body: { region: string } }>("/download/osm", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");

    // Stream NDJSON progress events back to the client. Hijacking the reply
    // lets us write line-by-line; Fastify otherwise buffers the full body.
    const stream = openNdjsonStream(reply);

    try {
      const result = await downloadOsm({
        region,
        dataDir,
        store,
        onProgress: (bytes, totalBytes) =>
          stream.writeLine({ event: "progress", bytes, totalBytes }),
      });
      stream.writeLine({ event: "done", ok: true, ...result });
    } catch (err) {
      stream.writeLine({ event: "error", message: (err as Error).message });
    } finally {
      stream.end();
    }
  });

  app.post<{
    Body: { feeds?: FeedDescriptor[]; countries?: string[]; source?: "transitous" };
  }>("/download/gtfs", async (req, reply) => {
    const { feeds, source } = req.body;
    const countries = req.body.countries ?? operationsPolicy.countries;
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
      let result: Awaited<ReturnType<typeof downloadGtfs>>;
      if (useTransitousPipeline) {
        const gtfsJobId = randomUUID();
        const ctx = buildJobContext({
          dataDir,
          store,
          countries,
          repoRoot: process.env.OPENMAPX_ROOT_DIR,
          source: parseTransitSource(),
          operationsPolicy: { ...operationsPolicy, countries },
          jobId: gtfsJobId,
          logger: asJobLogger(
            jobChildLogger({
              job: "transitous-sync",
              jobId: gtfsJobId,
              trigger: "download-gtfs",
            }),
          ),
        });
        await runTransitousPipeline(ctx);
        result = toDownloadGtfsResult(ctx, []);
      } else {
        result = await downloadGtfs({
          feeds,
          countries,
          dataDir,
          store,
        });
      }
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

  app.post<{ Body: { region: string } }>("/overture/pull", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply);

    try {
      const result = await pullOverture({
        region,
        dataDir,
        onProgress: (msg) => stream.writeLine({ event: "progress", message: msg }),
      });
      stream.writeLine({ event: "done", ok: true, path: result });
    } catch (err) {
      stream.writeLine({ event: "error", message: (err as Error).message });
    } finally {
      stream.end();
    }
  });

  app.get("/overture/status", async (_req, reply) => {
    const state = await getOvertureConflationState();
    if (!state) {
      reply.code(404);
      return { ok: false, error: "overture_places not ingested" };
    }
    const heartbeatAgeMs = Math.max(0, Date.now() - state.updatedAt.getTime());
    return {
      ok: true,
      ...state,
      heartbeatAgeMs,
      stalled: state.status === "running" && heartbeatAgeMs > 30 * 60 * 1000,
    };
  });

  app.post<{ Body: { region: string } }>("/overture/sync", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply);

    try {
      const result = await syncOvertureRegion({
        region,
        dataDir,
        onProgress: (message) => stream.writeLine({ event: "progress", message }),
      });
      stream.writeLine({ event: "done", ok: true, ...result });
    } catch (err) {
      stream.writeLine({ event: "error", message: (err as Error).message });
    } finally {
      stream.end();
    }
  });

  app.post<{ Body: { region: string } }>("/overture/ingest", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply);

    try {
      await withOvertureOperationLock(() =>
        ingestOverture({
          region,
          dataDir,
          onProgress: (msg) => stream.writeLine({ event: "progress", message: msg }),
        }),
      );
      stream.writeLine({ event: "done", ok: true });
    } catch (err) {
      stream.writeLine({ event: "error", message: (err as Error).message });
    } finally {
      stream.end();
    }
  });

  app.post<{ Body: { region: string } }>("/overture/extract", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply);

    try {
      await withOvertureOperationLock(() =>
        extractOsmPois({
          region,
          dataDir,
          onProgress: (msg) => stream.writeLine({ event: "progress", message: msg }),
        }),
      );
      stream.writeLine({ event: "done", ok: true });
    } catch (err) {
      stream.writeLine({ event: "error", message: (err as Error).message });
    } finally {
      stream.end();
    }
  });

  app.post<{ Body: { region: string; restart?: boolean } }>(
    "/overture/conflate",
    async (req, reply) => {
      const { region, restart } = req.body;
      if (!region) throw new Error("region required");
      assertValidRegion(region);

      const ollamaUrl = process.env.OLLAMA_URL || "http://local-ai:11434";

      const stream = openNdjsonStream(reply);

      try {
        const result = await rebuildOvertureLinks({
          region,
          dataDir,
          force: restart === true,
          ollamaUrl,
          useEmbeddings: false,
          onProgress: (msg) => stream.writeLine({ event: "progress", message: msg }),
        });
        stream.writeLine({
          event: "done",
          ok: result.status !== "failed" && result.status !== "waiting_for_osm",
          message:
            result.status === "failed"
              ? result.error
              : result.status === "waiting_for_osm"
                ? `OSM PBF not found at ${result.pbfPath}`
                : undefined,
          ...result,
        });
      } catch (err) {
        stream.writeLine({ event: "error", message: (err as Error).message });
      } finally {
        stream.end();
      }
    },
  );

  // POST /transit/sync — fire-and-forget Transitous pipeline trigger. Honours
  // the single-flight lock + idempotency key. apps/api proxies user-facing
  // sync requests here.
  app.post<{
    Body?: {
      idempotencyKey?: string;
      triggeredBy?: string;
      countries?: string[];
    };
  }>("/transit/sync", async (req, reply) => {
    const body = req.body ?? {};
    // Default to the deployment's configured countries (same as the cron) when
    // the caller doesn't specify any — an empty list means "every country",
    // which would kick off a global multi-GB fetch by accident.
    const countries = body.countries ?? operationsPolicy.countries;
    const outsideScope = countries.filter(
      (country) => !operationsPolicy.countries.includes(country.toLowerCase()),
    );
    if (operationsPolicy.profile !== "planet" && outsideScope.length > 0) {
      return reply.code(422).send({
        ok: false,
        reason: `countries outside configured operations profile: ${outsideScope.join(", ")}`,
      });
    }
    const start = await singleFlight.tryStartSync({
      trigger: "api",
      triggeredBy: body.triggeredBy ?? "api",
      idempotencyKey: body.idempotencyKey,
      kind: "transitous-sync",
      metadata: {
        source: "api",
        countries,
      },
    });

    if (!start.ok) {
      // 409 Conflict captures both "in-flight" and "duplicate-idempotency-key".
      // The caller distinguishes via the `reason` payload.
      return reply.code(409).send({
        ok: false,
        reason: start.reason,
        existingJobId: start.existingJobId,
      });
    }

    const jobId = start.jobId;
    launchReservedTransitSync(jobId, countries, "api");

    reply.code(202);
    return { ok: true, jobId, status: "started" };
  });

  // POST /transit/restart-motis — bounce the primary MOTIS container. Used
  // when a config change requires a full restart rather than the partial
  // reloads the pipeline already performs.
  app.post("/transit/restart-motis", async (_req, reply) => {
    try {
      await execa("docker", ["restart", PRIMARY_CONTAINER], { stdio: "pipe", timeout: 60_000 });
      return { ok: true, status: "restart-initiated" };
    } catch (err) {
      // The most common failure mode is "data-manager container has no
      // docker socket mounted" (Batch C concern). Surface a 503 so the
      // operator sees an actionable error.
      app.log.warn({ err }, "transitous-api: docker restart motis failed");
      reply.code(503);
      return {
        ok: false,
        error: "docker-unavailable",
        message: (err as Error).message,
      };
    }
  });

  // POST /transit/bump — propose a new pin set. It never activates the lock;
  // operators must review diffs/build the inactive slot before approval.
  app.post<{
    Body?: { branch?: string; force?: boolean; lockedBy?: string };
  }>("/transit/bump", async (req, reply) => {
    const branch = req.body?.branch?.trim() || "main";
    if (!isSafeGitRef(branch)) {
      reply.code(400);
      return {
        ok: false,
        error: "invalid-branch",
        message: `branch "${branch}" is not a valid git ref name`,
      };
    }

    if (!repoRoot) {
      reply.code(503);
      return {
        ok: false,
        error: "repo-root-not-configured",
        message: "OPENMAPX_ROOT_DIR is not set; data-manager cannot locate the lockfile",
      };
    }

    const force = req.body?.force === true;
    const lockedBy = req.body?.lockedBy?.trim() || "api";

    const catalogDir = join(dataDir, ".transitous-catalog");

    let candidate: Awaited<ReturnType<typeof resolveCatalogBumpCandidate>>;
    try {
      candidate = await resolveCatalogBumpCandidate({ catalogDir, branch });
    } catch (err) {
      if (err instanceof CatalogBumpError) {
        const status =
          err.code === "catalog-not-cloned" ? 409 : err.code === "git-fetch-failed" ? 502 : 500;
        reply.code(status);
        return { ok: false, error: err.code, message: err.message };
      }
      throw err;
    }

    const existing = readTransitousLock(repoRoot);
    if (candidateMatchesLock(candidate, existing) && !force) {
      return {
        ok: true,
        unchanged: true,
        ref: candidate.ref,
        previousRef: existing?.ref ?? null,
      };
    }

    const lock = lockFromCandidate(
      candidate,
      lockedBy,
      "Pinned commit of public-transport/transitous consumed by services/data-manager. Bumped via POST /transit/bump.",
    );
    writeTransitousLockProposal(repoRoot, lock);

    return {
      ok: true,
      unchanged: false,
      proposed: true,
      ref: lock.ref,
      previousRef: existing?.ref ?? null,
      submoduleSha: candidate.transitlandAtlasSha,
      lockedAt: lock.lockedAt,
      lockedBy: lock.lockedBy,
    };
  });

  app.post<{ Body?: { approveRef?: string; approvedBy?: string } }>(
    "/transit/bump/approve",
    async (req, reply) => {
      const proposal = readTransitousLockProposal(repoRoot);
      if (!proposal) return reply.code(404).send({ ok: false, error: "no-proposal" });
      if (req.body?.approveRef !== proposal.ref) {
        return reply.code(422).send({
          ok: false,
          error: "typed-confirmation-mismatch",
          expected: proposal.ref,
        });
      }
      const approved: TransitousLock = {
        ...proposal,
        lockedAt: new Date().toISOString(),
        lockedBy: req.body?.approvedBy?.trim() || "api-approval",
        comment: "Approved after compatibility review and inactive-slot validation.",
      };
      writeTransitousLock(repoRoot, approved);
      rmSync(join(repoRoot, "infra/docker/transitous.lock.proposed.json"), { force: true });
      return { ok: true, activated: true, ref: approved.ref, lockedAt: approved.lockedAt };
    },
  );
}
