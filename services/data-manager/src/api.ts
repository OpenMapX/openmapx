import { createReadStream } from "node:fs";
import { join } from "node:path";
import {
  type OfflinePackageRequest,
  parseOfflinePackageRequest,
  type TrafficApplicationSnapshot,
} from "@openmapx/core";
import { feedState } from "@openmapx/db-schema";
import { parseTransitSource } from "@openmapx/transitous-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { type CoverageApiOptions, registerCoverageEvidenceRoute } from "./coverage/api.js";
import type { CoverageSnapshotStore } from "./coverage/snapshot-store.js";
import { db, sql } from "./db/index.js";
import { registerAmbientPlacesApi } from "./jobs/ambient-places/api.js";
import { convertPbfToBz2ForRegion } from "./jobs/convert-overpass.js";
import { downloadFonts } from "./jobs/download-fonts.js";
import { downloadOsm } from "./jobs/download-osm.js";
import { applyHardlinkPlan } from "./jobs/link.js";
import {
  type BuildNotablePlacesOptions,
  buildNotablePlaces,
  type NotablePlacesBuildResult,
} from "./jobs/notable-places/build.js";
import { notablePlacesSettings } from "./jobs/notable-places/schedule.js";
import {
  createNotablePlacesRuntimeState,
  getNotablePlacesStatus,
  type NotablePlacesRuntimeState,
} from "./jobs/notable-places/state.js";
import { extractOsmPois } from "./jobs/overture/extract-osm-pois.js";
import { ingestOverture } from "./jobs/overture/ingest.js";
import { withOvertureOperationLock } from "./jobs/overture/operation-lock.js";
import { assertValidRegion, pullOverture } from "./jobs/overture/pull.js";
import { getOvertureConflationState, rebuildOvertureLinks } from "./jobs/overture/rebuild-links.js";
import { syncOvertureRegion } from "./jobs/overture/sync.js";
import {
  type BuildOsmSearchIndexOptions,
  buildOsmSearchIndex,
  type SearchIndexBuildResult,
} from "./jobs/search-index/build.js";
import {
  createNotablePlacesOperationLock,
  createSearchIndexOperationLock,
  type SearchIndexOperationLock,
} from "./jobs/search-index/operation-lock.js";
import {
  createSearchIndexRuntimeState,
  fingerprintDataset,
  getSearchIndexStatus,
  updateCurrentSearchIndexFingerprint,
} from "./jobs/search-index/state.js";
import type { BakePredictedResult } from "./jobs/traffic/bake-predicted.js";
import {
  CatalogBumpError,
  candidateMatchesLock,
  lockFromCandidate,
  resolveCatalogBumpCandidate,
} from "./jobs/transitous/catalog-bump.js";
import { buildJobContext, runTransitousPipeline } from "./jobs/transitous/index.js";
import { resolveTransitOverlayPath } from "./jobs/transitous/internal.js";
import {
  type MotisOperationsPolicy,
  publicOperationsPolicy,
  resolveOperationsProfileFromEnv,
} from "./jobs/transitous/operations-profile.js";
import {
  getOperatorFeedRelayStore,
  OperatorFeedRelayCapabilityError,
  type OperatorFeedRelayStore,
} from "./jobs/transitous/operator-feed-relay.js";
import { finalizeJobRow, makePersistingOnStageComplete } from "./jobs/transitous/persistence.js";
import { runMotisPreflight } from "./jobs/transitous/preflight.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
import { asJobLogger, jobChildLogger } from "./logger.js";
import {
  OFFLINE_PACKAGE_PRINCIPAL_PATTERN,
  OfflinePackagePrincipalQuotaError,
} from "./offline-packages/accounting.js";
import {
  OfflinePackageCapacityError,
  type OfflinePackageGenerator,
} from "./offline-packages/generator.js";
import { isContentAddressedPackageId } from "./offline-packages/storage.js";
import { runOpsOperation } from "./ops-client.js";
import type { DataManagerReadinessSnapshot } from "./readiness.js";
import {
  registerDataManagerRoute,
  validateDataManagerEvent,
  validateDataManagerResponseHeaders,
} from "./route-contract.js";
import { StateStore } from "./state.js";
import {
  listPinnedTransitCatalog,
  listTransitSources,
  prepareAddTransitSource,
  prepareEnableTransitSource,
  prepareRemoveTransitSource,
  type TransitFeedStateEvidence,
  TransitSourceError,
} from "./transit-sources.js";

export interface ApiOptions {
  dataDir?: string;
  /**
   * Single-flight controller. Defaults to the process-wide singleton so the
   * cron + `/transit/sync` share state; tests inject an isolated controller.
   */
  singleFlight?: SingleFlightController;
  operationsPolicy?: MotisOperationsPolicy;
  /** Test seam invoked after reservation; production launches the real pipeline. */
  launchTransitSync?: (args: { jobId: string; countries: string[]; trigger: string }) => void;
  /**
   * Runs the predicted-traffic bake. Wired in `service.ts` only when
   * `OPENCONDITIONS_URL` is configured, so the route can answer 501 rather than
   * pretending to work on a deployment without OpenConditions.
   */
  bakePredicted?: () => Promise<BakePredictedResult>;
  /** Latest committed actuation evidence, matched to the actual serving route response. */
  getTrafficConditionsApplied?: () => TrafficApplicationSnapshot;
  /** Offline package generator initialized by the process entrypoint. */
  offlinePackages?: OfflinePackageGenerator;
  /** Search-index database/test seam. */
  searchIndexSql?: postgres.Sql;
  /** Test seam for the country-scale OSM search-index build. */
  buildSearchIndex?: (opts: BuildOsmSearchIndexOptions) => Promise<SearchIndexBuildResult>;
  /**
   * Build state and lock shared with the scheduled refresh, so a build started
   * here and one started by the schedule never overlap. Created here when the
   * process entrypoint supplies none (route tests).
   */
  notablePlaces?: {
    runtimeState: NotablePlacesRuntimeState;
    operationLock: SearchIndexOperationLock;
    build?: (opts: BuildNotablePlacesOptions) => Promise<NotablePlacesBuildResult>;
  };
  /** Process startup readiness; omitted by isolated route tests, which are ready immediately. */
  readiness?: () => DataManagerReadinessSnapshot;
  /** Process-wide one-run relay shared with the Transitous pipeline. */
  operatorFeedRelay?: OperatorFeedRelayStore;
  /** Optional coverage evidence seam; production constructs the bounded store. */
  coverageSnapshotStore?: CoverageSnapshotStore;
}

const startedAt = Date.now();

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
function openNdjsonStream(
  reply: FastifyReply,
  operationId: import("@openmapx/core/data-manager-contracts").DataManagerOperationKey,
): NdjsonStream {
  const headers = {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  };
  validateDataManagerResponseHeaders(operationId, 200, headers);
  reply.hijack();
  reply.raw.writeHead(200, headers);

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
    writeLine: (obj) => write(`${JSON.stringify(validateDataManagerEvent(operationId, obj))}\n`),
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

interface ByteRange {
  start: number;
  end: number;
}

function parseByteRange(value: string, total: number): ByteRange | undefined {
  if (!/^bytes=\d*-\d*$/.test(value)) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return undefined;
  const startValue = match[1];
  const endValue = match[2];
  if (!startValue && !endValue) return undefined;
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || total === 0) return undefined;
    return { start: Math.max(0, total - suffixLength), end: total - 1 };
  }
  const start = Number(startValue);
  if (!Number.isSafeInteger(start) || start >= total) return undefined;
  const requestedEnd = endValue ? Number(endValue) : total - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return undefined;
  return { start, end: Math.min(requestedEnd, total - 1) };
}

function registerOfflinePackageRoutes(
  app: FastifyInstance,
  generator: OfflinePackageGenerator,
): void {
  const principal = (request: FastifyRequest): string | undefined => {
    const rawValues: string[] = [];
    for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
      if (request.raw.rawHeaders[index]?.toLowerCase() === "x-offline-package-principal") {
        rawValues.push(request.raw.rawHeaders[index + 1] ?? "");
      }
    }
    const value = request.headers["x-offline-package-principal"];
    if (
      rawValues.length !== 1 ||
      typeof value !== "string" ||
      value.includes(",") ||
      !OFFLINE_PACKAGE_PRINCIPAL_PATTERN.test(value)
    ) {
      return undefined;
    }
    return value;
  };

  registerDataManagerRoute(app, "getOfflinePackageCapability", async (_request, reply) => {
    return reply.send(await generator.getCapability());
  });

  registerDataManagerRoute(app, "prepareOfflinePackage", async (request, reply) => {
    const owner = principal(request);
    if (!owner) {
      return reply.code(400).send({
        ok: false,
        errorCode: "invalid-principal",
        errorMessage: "Exactly one valid offline package principal is required",
      });
    }
    let body: OfflinePackageRequest;
    try {
      body = parseOfflinePackageRequest(request.body);
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        errorCode: "invalid-request",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const result = await generator.prepare(owner, body);
      if (result.status === "ready-to-download") return reply.code(200).send(result);
      if (result.status === "preparing") return reply.code(202).send(result);
      const status = result.errorCode === "capacity" ? 409 : 400;
      return reply.code(status).send(result);
    } catch (error) {
      if (error instanceof OfflinePackageCapacityError) {
        reply.header("Retry-After", "30");
        return reply.code(429).send({
          ok: false,
          errorCode: error.errorCode,
          errorMessage: error.message,
        });
      }
      if (error instanceof OfflinePackagePrincipalQuotaError) {
        reply.header("Retry-After", "30");
        return reply.code(429).send({
          ok: false,
          errorCode: error.errorCode,
          errorMessage: error.message,
          retryAfterSeconds: 30,
        });
      }
      return reply.code(503).send({
        ok: false,
        errorCode: "source-unavailable",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  });

  registerDataManagerRoute(app, "getOfflinePackageJob", async (request, reply) => {
    const owner = principal(request);
    if (!owner) {
      return reply.code(400).send({
        ok: false,
        errorCode: "invalid-principal",
        errorMessage: "Exactly one valid offline package principal is required",
      });
    }
    const result = await generator.getJob(owner, request.params.jobId);
    if (!result) return reply.code(404).send({ ok: false, error: "offline package job not found" });
    return reply.send(result);
  });

  registerDataManagerRoute(app, "getOfflinePackageManifest", async (request, reply) => {
    if (!isContentAddressedPackageId(request.params.packageId)) {
      return reply.code(400).send({ ok: false, error: "invalid offline package id" });
    }
    const manifest = await generator.getManifest(request.params.packageId);
    if (!manifest) return reply.code(404).send({ ok: false, error: "offline package not found" });
    return reply.send(manifest);
  });

  const serveGlyph = async (
    request: FastifyRequest<{ Params: { version: string; fontstack: string; range: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const asset = await generator.openGlyph(
      request.params.version,
      request.params.fontstack,
      request.params.range,
    );
    if (!asset)
      return reply.code(404).send({ ok: false, error: "offline package glyph not found" });
    reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("Content-Type", asset.contentType)
      .header("Content-Length", String(asset.byteLength));
    if (request.method === "HEAD") return reply.send();
    if ("body" in asset) return reply.send(Buffer.from(asset.body));
    return reply.send(createReadStream(asset.path));
  };

  registerDataManagerRoute(app, "getOfflineGlyphCatalog", async (request, reply) => {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.params.version)) {
      return reply.code(400).send({ ok: false, error: "invalid offline glyph version" });
    }
    const catalog = await generator.glyphCatalog(request.params.version);
    if (!catalog) return reply.code(404).send({ ok: false, error: "offline glyphs not found" });
    return reply.header("Cache-Control", "public, max-age=31536000, immutable").send(catalog);
  });

  registerDataManagerRoute(app, "headOfflineGlyph", serveGlyph);
  registerDataManagerRoute(app, "getOfflineGlyph", serveGlyph);

  const serveArchive = async (
    request: FastifyRequest<{ Params: { packageId: string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const { packageId } = request.params;
    if (!isContentAddressedPackageId(packageId)) {
      return reply.code(400).send({ ok: false, error: "invalid offline package id" });
    }
    const manifest = await generator.getManifest(packageId);
    if (!manifest) return reply.code(404).send({ ok: false, error: "offline package not found" });
    const archive = await generator.openArchive(packageId);
    if (!archive) return reply.code(404).send({ ok: false, error: "offline package not found" });

    const total = archive.byteLength;
    const ifRange = request.headers["if-range"];
    const rangeHeader = request.headers.range;
    const useRange =
      typeof rangeHeader === "string" && (!ifRange || ifRange === manifest.archive.etag);
    const range = useRange && rangeHeader ? parseByteRange(rangeHeader, total) : undefined;
    if (useRange && rangeHeader && !range) {
      archive.release();
      return reply
        .code(416)
        .header("Content-Range", `bytes */${total}`)
        .header("Accept-Ranges", "bytes")
        .header("ETag", manifest.archive.etag)
        .send();
    }

    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": manifest.archive.contentType,
      ETag: manifest.archive.etag,
    };
    if (range) {
      headers["Content-Length"] = String(range.end - range.start + 1);
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${total}`;
      reply.code(206);
    } else {
      headers["Content-Length"] = String(total);
      reply.code(200);
    }
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);

    if (request.method === "HEAD") {
      archive.release();
      return reply.send();
    }

    const stream = createReadStream(
      archive.path,
      range ? { start: range.start, end: range.end } : undefined,
    );
    const release = () => archive.release();
    stream.once("close", release);
    stream.once("error", release);
    return reply.send(stream);
  };

  registerDataManagerRoute(app, "headOfflinePackageArchive", serveArchive);
  registerDataManagerRoute(app, "getOfflinePackageArchive", serveArchive);
}

export function registerApi(app: FastifyInstance, opts: ApiOptions = {}): void {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "/data";
  const singleFlight = opts.singleFlight ?? getSingleFlightController();
  const store = new StateStore(dataDir);
  const searchIndexSql = opts.searchIndexSql ?? sql;
  registerAmbientPlacesApi(app, searchIndexSql);
  const searchIndexRuntimeState = createSearchIndexRuntimeState();
  const searchIndexOperationLock = createSearchIndexOperationLock(searchIndexSql);
  const notablePlaces = opts.notablePlaces ?? {
    runtimeState: createNotablePlacesRuntimeState(),
    operationLock: createNotablePlacesOperationLock(searchIndexSql),
  };
  const operationsPolicy =
    opts.operationsPolicy ??
    resolveOperationsProfileFromEnv(process.env, { allowEmptyRegional: true });
  const catalogDir = join(dataDir, ".transitous-catalog");
  const overlayPath = resolveTransitOverlayPath(dataDir);
  const operatorFeedRelay = opts.operatorFeedRelay ?? getOperatorFeedRelayStore();
  if (!opts.operatorFeedRelay) {
    operatorFeedRelay.setAuditSink((event) => {
      app.log.info(event, "transitous-operator-feed: safe remote acquisition");
    });
  }

  registerCoverageEvidenceRoute(app, {
    dataDir,
    sql: searchIndexSql,
    stateStore: store,
    ...(opts.coverageSnapshotStore ? { snapshotStore: opts.coverageSnapshotStore } : {}),
  } satisfies CoverageApiOptions);

  if (opts.offlinePackages) registerOfflinePackageRoutes(app, opts.offlinePackages);

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
          source: parseTransitSource(),
          operationsPolicy: { ...operationsPolicy, countries },
          jobId,
          logger: jobLog,
          onStageComplete: persistingHook,
          feedsOverlayPath: overlayPath,
          operatorFeedRelay,
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

  registerDataManagerRoute(app, "getLive", async () => ({ ok: true }));

  registerDataManagerRoute(app, "getTransitOperatorFeed", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    reply.header("Referrer-Policy", "no-referrer");
    const requestAbort = new AbortController();
    const abortDisconnectedClient = (): void => {
      requestAbort.abort(new Error("Relay client disconnected"));
    };
    req.raw.once("aborted", abortDisconnectedClient);
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) abortDisconnectedClient();
    });
    try {
      const payload = await operatorFeedRelay.consume({
        handle: req.params.handle,
        signal: requestAbort.signal,
      });
      reply.header("Content-Type", payload.contentType ?? "application/zip");
      reply.header("Content-Length", String(payload.bytes));
      return reply.send(payload.stream);
    } catch (error) {
      const status = error instanceof OperatorFeedRelayCapabilityError ? 410 : 502;
      return reply.code(status).send({ error: "operator feed relay unavailable" });
    }
  });

  registerDataManagerRoute(app, "getStatus", async (_req, reply) => {
    const readiness = opts.readiness?.() ?? { status: "ready", phase: "complete" };
    const body = {
      ok: readiness.status === "ready",
      status: readiness.status,
      phase: readiness.phase,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      dataDir,
    };
    if (!body.ok) return reply.code(503).send(body);
    return body;
  });

  registerDataManagerRoute(app, "getDatasets", async () => ({ datasets: store.getAll() }));

  registerDataManagerRoute(app, "getTransitProfile", async () => ({
    policy: publicOperationsPolicy(operationsPolicy),
  }));

  registerDataManagerRoute(app, "getTransitSources", async (req, reply) => {
    const parseCount = (raw: number | undefined, fallback: number): number => {
      const value = Number(raw ?? fallback);
      return Number.isFinite(value) ? value : fallback;
    };
    try {
      // Desired and active evidence live on local disk; a Postgres outage
      // only degrades the fetch/import/validation columns.
      let feedStates: TransitFeedStateEvidence[] | undefined;
      try {
        feedStates = await db.select().from(feedState);
      } catch (error) {
        req.log.warn({ err: error }, "transit-sources: feed_state unavailable, listing without it");
      }
      return listTransitSources({
        dataDir,
        catalogDir,
        overlayPath,
        countries: operationsPolicy.countries,
        feedStates,
        query: {
          search: req.query.search,
          lifecycle: req.query.lifecycle,
          origin: req.query.origin,
          limit: parseCount(req.query.limit, 100),
          offset: parseCount(req.query.offset, 0),
        },
      });
    } catch (error) {
      const status = error instanceof TransitSourceError ? error.statusCode : 500;
      return reply.code(status).send({ ok: false, error: (error as Error).message });
    }
  });

  registerDataManagerRoute(app, "getTransitCatalog", async (_req, reply) => {
    try {
      return { sources: listPinnedTransitCatalog(catalogDir, operationsPolicy.countries) };
    } catch (error) {
      const status = error instanceof TransitSourceError ? error.statusCode : 500;
      return reply.code(status).send({ ok: false, error: (error as Error).message });
    }
  });

  registerDataManagerRoute(app, "addTransitSource", async (req, reply) => {
    let mutation: ReturnType<typeof prepareAddTransitSource>;
    try {
      mutation = prepareAddTransitSource({
        catalogDir,
        overlayPath,
        countries: operationsPolicy.countries,
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

  registerDataManagerRoute(app, "removeTransitSource", async (req, reply) => {
    let mutation: ReturnType<typeof prepareRemoveTransitSource>;
    try {
      mutation = prepareRemoveTransitSource({
        catalogDir,
        overlayPath,
        countries: operationsPolicy.countries,
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

  registerDataManagerRoute(app, "enableTransitSource", async (req, reply) => {
    let mutation: ReturnType<typeof prepareEnableTransitSource>;
    try {
      mutation = prepareEnableTransitSource({
        catalogDir,
        overlayPath,
        countries: operationsPolicy.countries,
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

  registerDataManagerRoute(app, "preflightTransit", async (req, reply) => {
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

  registerDataManagerRoute(app, "reloadDatasets", async () => {
    const result = store.reload();
    return { ok: true, ...result };
  });

  // Single-flight: the bake shells out to a slow tile-rewriting tool and
  // restarts Valhalla, so two concurrent runs would fight over the same tiles.
  let bakeInFlight = false;

  registerDataManagerRoute(app, "bakePredictedTraffic", async (_req, reply) => {
    if (!opts.bakePredicted) {
      reply.code(501);
      return { error: "predicted bake not configured" };
    }
    if (bakeInFlight) {
      reply.code(409);
      return { error: "a predicted bake is already running" };
    }
    bakeInFlight = true;
    void opts
      .bakePredicted()
      .then((result) => {
        app.log.info({ ...result }, "traffic-predicted: manual bake complete");
      })
      .catch((err: unknown) => {
        app.log.error({ err: (err as Error).message }, "traffic-predicted: manual bake failed");
      })
      .finally(() => {
        bakeInFlight = false;
      });
    reply.code(202);
    return { accepted: true };
  });

  // Authenticated, uncached application snapshot for per-request engine proof.
  registerDataManagerRoute(app, "getAppliedTrafficConditions", async (_req, reply) => {
    if (!opts.getTrafficConditionsApplied) {
      reply.code(501);
      return { error: "live traffic not configured" };
    }
    reply.header("Cache-Control", "no-store");
    return opts.getTrafficConditionsApplied();
  });

  registerDataManagerRoute(app, "downloadOsm", async (req, reply) => {
    const { region } = req.body ?? {};
    if (!region || typeof region !== "string") throw new Error("region required");
    // Same Geofabrik path shape the Overture routes enforce — the region becomes
    // both a download URL segment and a local filename.
    assertValidRegion(region);

    // Stream NDJSON progress events back to the client. Hijacking the reply
    // lets us write line-by-line; Fastify otherwise buffers the full body.
    const stream = openNdjsonStream(reply, "downloadOsm");

    try {
      const result = await downloadOsm({
        region,
        dataDir,
        store,
        onProgress: (bytes, totalBytes) =>
          stream.writeLine({ event: "progress", bytes, totalBytes }),
        // Network transfer and checksum verification stay outside the lock;
        // only the final atomic rename can race Overture fingerprinting.
        withPublishLock: (publish) =>
          withOvertureOperationLock(async () => {
            publish();
          }),
      });
      const dataset = store
        .getAll()
        .find((entry) => entry.type === "osm-pbf" && (entry.region ?? entry.id) === region);
      if (dataset) {
        try {
          await updateCurrentSearchIndexFingerprint(
            searchIndexSql,
            region,
            await fingerprintDataset(dataset),
          );
        } catch (error) {
          req.log.warn(
            { err: error },
            "download-osm: could not update current search-index fingerprint",
          );
        }
      }
      stream.writeLine({ event: "done", ok: true, ...result });
    } catch (err) {
      stream.writeLine({ event: "error", message: (err as Error).message });
    } finally {
      stream.end();
    }
  });

  registerDataManagerRoute(app, "getSearchIndexStatus", async (_req, reply) => {
    const status = await getSearchIndexStatus({
      dataDir,
      store,
      sql: searchIndexSql,
      runtimeState: searchIndexRuntimeState,
    });
    if (!status) {
      return reply.code(404).send({ ok: false, error: "osm_search index not built" });
    }
    return reply.send({ ok: true, ...status });
  });

  registerDataManagerRoute(app, "buildSearchIndex", async (req, reply) => {
    const { region } = req.body ?? {};
    if (!region || typeof region !== "string") {
      return reply.code(400).send({ ok: false, error: "region required" });
    }
    assertValidRegion(region);
    const stream = openNdjsonStream(reply, "buildSearchIndex");
    try {
      const build = opts.buildSearchIndex ?? buildOsmSearchIndex;
      const result = await build({
        region,
        dataDir,
        store,
        sql: searchIndexSql,
        runtimeState: searchIndexRuntimeState,
        operationLock: searchIndexOperationLock,
        onProgress: (progress) => stream.writeLine({ event: "progress", ...progress }),
      });
      stream.writeLine({ event: "done", ok: true, ...result });
    } catch (error) {
      stream.writeLine({ event: "error", message: (error as Error).message });
    } finally {
      stream.end();
    }
  });

  registerDataManagerRoute(app, "getNotablePlacesStatus", async (_req, reply) => {
    const status = await getNotablePlacesStatus({
      sql: searchIndexSql,
      runtimeState: notablePlaces.runtimeState,
    });
    if (!status) {
      return reply.code(404).send({ ok: false, error: "notable_places index not built" });
    }
    return reply.send({ ok: true, ...status });
  });

  registerDataManagerRoute(app, "buildNotablePlaces", async (_req, reply) => {
    const stream = openNdjsonStream(reply, "buildNotablePlaces");
    try {
      const build = notablePlaces.build ?? buildNotablePlaces;
      const result = await build({
        sql: searchIndexSql,
        runtimeState: notablePlaces.runtimeState,
        operationLock: notablePlaces.operationLock,
        ...notablePlacesSettings(),
        onProgress: (progress) => stream.writeLine({ event: "progress", ...progress }),
      });
      stream.writeLine({ event: "done", ok: true, ...result });
    } catch (error) {
      stream.writeLine({ event: "error", message: (error as Error).message });
    } finally {
      stream.end();
    }
  });

  registerDataManagerRoute(app, "downloadFonts", async () => {
    await downloadFonts({ dataDir, store });
    return { ok: true };
  });

  registerDataManagerRoute(app, "link", async (req) => {
    const { plan, prune } = req.body;
    const result = await applyHardlinkPlan(plan, { rootDir: dataDir, prune });
    return { ok: true, ...result };
  });

  registerDataManagerRoute(app, "convertOverpass", async (req, reply) => {
    const { region } = req.body ?? {};

    const stream = openNdjsonStream(reply, "convertOverpass");
    try {
      const result = await convertPbfToBz2ForRegion({
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
    return undefined;
  });

  registerDataManagerRoute(app, "pullOverture", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply, "pullOverture");

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

  registerDataManagerRoute(app, "getOvertureStatus", async (_req, reply) => {
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

  registerDataManagerRoute(app, "syncOverture", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply, "syncOverture");

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

  registerDataManagerRoute(app, "ingestOverture", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply, "ingestOverture");

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

  registerDataManagerRoute(app, "extractOverture", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const stream = openNdjsonStream(reply, "extractOverture");

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

  registerDataManagerRoute(app, "conflateOverture", async (req, reply) => {
    const { region, restart } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const ollamaUrl = process.env.OLLAMA_URL || "http://local-ai:11434";

    const stream = openNdjsonStream(reply, "conflateOverture");

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
              : result.status === "already_running"
                ? "Another worker still owns the active conflation lease"
                : undefined,
        ...result,
      });
    } catch (err) {
      stream.writeLine({ event: "error", message: (err as Error).message });
    } finally {
      stream.end();
    }
  });

  // POST /transit/sync — fire-and-forget Transitous pipeline trigger. Honours
  // the single-flight lock + idempotency key. apps/api proxies user-facing
  // sync requests here.
  registerDataManagerRoute(app, "syncTransit", async (req, reply) => {
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
  registerDataManagerRoute(app, "restartMotis", async (_req, reply) => {
    try {
      // Data-manager holds no Docker socket: the restart is a typed operation
      // the agent performs against its own fixed container.
      await runOpsOperation({ kind: "motis.primary.restart" });
      return { ok: true, status: "restart-initiated" };
    } catch (err) {
      // The most common failure mode is that the operations agent is
      // unreachable or has not been configured. Surface a 503 so the operator
      // sees an actionable error.
      app.log.warn({ err }, "transitous-api: motis restart operation failed");
      reply.code(503);
      return {
        ok: false,
        error: "ops-agent-unavailable",
        message: (err as Error).message,
      };
    }
  });

  // POST /transit/bump — propose a new pin set. It never activates the lock;
  // operators must review diffs/build the inactive slot before approval.
  registerDataManagerRoute(app, "proposeTransitBump", async (req, reply) => {
    const branch = req.body?.branch?.trim() || "main";
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

    const { active: existing } = await runOpsOperation({ kind: "transitousLock.inspect" });
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
    // The proposal file lives under the repository's `infra/docker/`, which only
    // the operations agent may write.
    await runOpsOperation({
      kind: "transitousLock.propose",
      ref: lock.ref,
      submodules: lock.submodules,
      lockedBy: lock.lockedBy,
      ...(lock.comment ? { comment: lock.comment } : {}),
    });

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

  registerDataManagerRoute(app, "approveTransitBump", async (req, reply) => {
    const { proposed } = await runOpsOperation({ kind: "transitousLock.inspect" });
    if (!proposed) return reply.code(404).send({ ok: false, error: "no-proposal" });
    if (req.body?.approveRef !== proposed.ref) {
      return reply.code(422).send({
        ok: false,
        error: "typed-confirmation-mismatch",
        expected: proposed.ref,
      });
    }
    // The agent re-matches the ref under its own read, so an approval cannot
    // land on a proposal that changed after this check.
    const approved = await runOpsOperation({
      kind: "transitousLock.approve",
      ref: proposed.ref,
      approvedBy: req.body?.approvedBy?.trim() || "api-approval",
    });
    return { ok: true, activated: true, ref: approved.ref, lockedAt: approved.lockedAt };
  });
}
