import { createReadStream } from "node:fs";
import { join } from "node:path";
import { setTimeout as observerDelay } from "node:timers/promises";
import {
  type OfflinePackageRequest,
  parseOfflinePackageRequest,
  type TrafficApplicationSnapshot,
} from "@openmapx/core";
import {
  type DataExecutionInput,
  type DataExecutionStatus,
  isDataExecutionTerminal,
} from "@openmapx/core/data-manager-contracts";
import { feedState } from "@openmapx/db-schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { type CoverageApiOptions, registerCoverageEvidenceRoute } from "./coverage/api.js";
import type { CoverageSnapshotStore } from "./coverage/snapshot-store.js";
import { db, sql } from "./db/index.js";
import { registerAmbientPlacesApi } from "./jobs/ambient-places/api.js";
import { type DataExecutionReceiver, registerDataExecutionApi } from "./jobs/execution/api.js";
import {
  startLegacyDataMutation,
  withLegacyDataMutation,
} from "./jobs/execution/legacy-mutation.js";
import {
  createNotablePlacesRuntimeState,
  getNotablePlacesStatus,
  type NotablePlacesRuntimeState,
} from "./jobs/notable-places/state.js";
import { getOvertureConflationState } from "./jobs/overture/rebuild-links.js";
import {
  createNotablePlacesOperationLock,
  type SearchIndexOperationLock,
} from "./jobs/search-index/operation-lock.js";
import { createSearchIndexRuntimeState, getSearchIndexStatus } from "./jobs/search-index/state.js";
import type { BakePredictedResult } from "./jobs/traffic/bake-predicted.js";
import {
  CatalogBumpError,
  candidateMatchesLock,
  lockFromCandidate,
  resolveCatalogBumpCandidate,
} from "./jobs/transitous/catalog-bump.js";
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
import { finalizeJobRow } from "./jobs/transitous/persistence.js";
import { runMotisPreflight } from "./jobs/transitous/preflight.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
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
  executionReceiver?: DataExecutionReceiver;
  dataDir?: string;
  /**
   * Single-flight controller. Defaults to the process-wide singleton so the
   * cron + `/transit/sync` share state; tests inject an isolated controller.
   */
  singleFlight?: SingleFlightController;
  operationsPolicy?: MotisOperationsPolicy;
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
  searchIndexRuntimeState?: ReturnType<typeof createSearchIndexRuntimeState>;
  /**
   * Build state and lock shared with the scheduled refresh, so a build started
   * here and one started by the schedule never overlap. Created here when the
   * process entrypoint supplies none (route tests).
   */
  notablePlaces?: {
    runtimeState: NotablePlacesRuntimeState;
    operationLock: SearchIndexOperationLock;
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
  registerDataExecutionApi(app, opts.executionReceiver);
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "/data";
  const singleFlight = opts.singleFlight ?? getSingleFlightController();
  const store = new StateStore(dataDir);
  const searchIndexSql = opts.searchIndexSql ?? sql;
  registerAmbientPlacesApi(app, searchIndexSql);
  const searchIndexRuntimeState = opts.searchIndexRuntimeState ?? createSearchIndexRuntimeState();
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

  async function admitLegacyData(input: DataExecutionInput) {
    if (!opts.executionReceiver)
      throw Object.assign(Error("Durable data receiver is unavailable"), { statusCode: 503 });
    return opts.executionReceiver.admitLocal(input);
  }
  async function observeLegacyData(
    status: DataExecutionStatus,
    reply: FastifyReply,
    operationId?: import("@openmapx/core/data-manager-contracts").DataManagerOperationKey,
  ) {
    const receiver = opts.executionReceiver;
    if (!receiver)
      throw Object.assign(Error("Durable data receiver is unavailable"), { statusCode: 503 });
    const observer = new AbortController(),
      closed = () => observer.abort();
    reply.raw.once("close", closed);
    reply.request.raw.once("aborted", closed);
    const stream = operationId ? openNdjsonStream(reply, operationId) : undefined;
    const unsubscribe = receiver.subscribe(status.id, (event) => stream?.writeLine(event));
    try {
      let current = status;
      while (!isDataExecutionTerminal(current) || current.publication === "unknown") {
        if (observer.signal.aborted) return undefined;
        const remaining = status.deadlineAt - Date.now();
        if (remaining <= 0)
          throw Error(
            `Data execution ${status.id} observer deadline elapsed; inspect its retained status`,
          );
        await observerDelay(Math.min(200, remaining), undefined, { signal: observer.signal });
        const found = await receiver.inspect(status.id);
        if (
          !found ||
          found.operationKey !== status.operationKey ||
          found.fingerprint !== status.fingerprint ||
          found.admittedAt !== status.admittedAt ||
          found.deadlineAt !== status.deadlineAt
        )
          throw Error(`Execution ${status.id} requires retained status observation`);
        current = found;
      }
      if (current.status !== "ok" && current.status !== "partial")
        throw Error(`Execution ${status.id} ${current.status}`);
      if (stream) stream.writeLine(receiver.legacyResult(status.id) ?? { event: "done", ok: true });
      return current;
    } catch (error) {
      if (!observer.signal.aborted) {
        if (stream) stream.writeLine({ event: "error", message: (error as Error).message });
        else throw error;
      }
      return undefined;
    } finally {
      unsubscribe();
      reply.raw.removeListener("close", closed);
      reply.request.raw.removeListener("aborted", closed);
      stream?.end();
    }
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
    if (!opts.executionReceiver)
      return {
        ok: false,
        status: 503,
        body: { ok: false, error: "Durable data receiver is unavailable" },
      };
    const start = await singleFlight.tryStartSync({
      trigger: "api",
      triggeredBy: options.triggeredBy,
      idempotencyKey: options.idempotencyKey,
      kind: `transit-source-${options.action}`,
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
    singleFlight.markSyncFinished(start.jobId);
    try {
      const admitted = await opts.executionReceiver.admitLocal(
        { kind: "transit-sync", countries: operationsPolicy.countries },
        { sourceJobId: start.jobId },
      );
      await finalizeJobRow(start.jobId, "ok");
      return { ok: true, jobId: admitted.id };
    } catch (error) {
      await finalizeJobRow(start.jobId, "error");
      throw error;
    }
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
    return withLegacyDataMutation(
      "data-reload",
      async () => ({ ok: true, ...store.reload() }),
      searchIndexSql,
    );
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
    let owned: Awaited<ReturnType<typeof startLegacyDataMutation>>;
    try {
      owned = await startLegacyDataMutation(
        "traffic-predicted",
        opts.bakePredicted,
        searchIndexSql,
      );
    } catch (error) {
      bakeInFlight = false;
      throw error;
    }
    void owned.completion
      .then((result) => {
        app.log.info({ result }, "traffic-predicted: manual bake complete");
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
    const admitted = await admitLegacyData({ kind: "download-osm", region: req.body.region });
    await observeLegacyData(admitted, reply, "downloadOsm");
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
    const admitted = await admitLegacyData({ kind: "search-index-build", region: req.body.region });
    await observeLegacyData(admitted, reply, "buildSearchIndex");
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
    const admitted = await admitLegacyData({ kind: "notable-places-build" });
    await observeLegacyData(admitted, reply, "buildNotablePlaces");
  });

  registerDataManagerRoute(app, "downloadFonts", async (_req, reply) => {
    const admitted = await admitLegacyData({ kind: "download-fonts" });
    await observeLegacyData(admitted, reply);
    if (!reply.raw.destroyed) return { ok: true };
    return undefined;
  });

  registerDataManagerRoute(app, "link", async (_req, reply) =>
    reply.code(503).send({ error: "A signed generation-hardlinks execution is required" }),
  );

  registerDataManagerRoute(app, "convertOverpass", async (req, reply) => {
    const admitted = await admitLegacyData({
      kind: "convert-overpass",
      region:
        req.body?.region ?? store.getAll().find((entry) => entry.type === "osm-pbf")?.region ?? "",
    });
    await observeLegacyData(admitted, reply, "convertOverpass");
  });

  registerDataManagerRoute(app, "pullOverture", async (req, reply) => {
    const admitted = await admitLegacyData({ kind: "overture-pull", region: req.body.region });
    await observeLegacyData(admitted, reply, "pullOverture");
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
    const admitted = await admitLegacyData({ kind: "overture-sync", region: req.body.region });
    await observeLegacyData(admitted, reply, "syncOverture");
  });

  registerDataManagerRoute(app, "ingestOverture", async (req, reply) => {
    const admitted = await admitLegacyData({ kind: "overture-ingest", region: req.body.region });
    await observeLegacyData(admitted, reply, "ingestOverture");
  });

  registerDataManagerRoute(app, "extractOverture", async (req, reply) => {
    const admitted = await admitLegacyData({ kind: "overture-extract", region: req.body.region });
    await observeLegacyData(admitted, reply, "extractOverture");
  });

  registerDataManagerRoute(app, "conflateOverture", async (req, reply) => {
    const admitted = await admitLegacyData({
      kind: "overture-conflate",
      region: req.body.region,
      restart: req.body.restart,
    });
    await observeLegacyData(admitted, reply, "conflateOverture");
  });

  // POST /transit/sync — fire-and-forget Transitous pipeline trigger. Honours
  // the single-flight lock + idempotency key. apps/api proxies user-facing
  // sync requests here.
  registerDataManagerRoute(app, "syncTransit", async (req, reply) => {
    const admitted = await admitLegacyData({
      kind: "transit-sync",
      countries: req.body?.countries ?? operationsPolicy.countries,
    });
    return reply.code(202).send({ ok: true, jobId: admitted.id, status: "started" });
  });

  // POST /transit/restart-motis — bounce the primary MOTIS container. Used
  // when a config change requires a full restart rather than the partial
  // reloads the pipeline already performs.
  registerDataManagerRoute(app, "restartMotis", async (_req, reply) => {
    if (!opts.executionReceiver)
      return reply.code(503).send({
        ok: false,
        error: "ops-agent-unavailable",
        message: "Durable data receiver is unavailable",
      });
    const admitted = await opts.executionReceiver.admitMaintenance("restart-primary");
    await observeLegacyData(admitted, reply);
    if (!reply.raw.destroyed) return { ok: true, status: "restart-initiated" };
    return undefined;
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
    await withLegacyDataMutation("transit-proposal", () =>
      runOpsOperation({
        kind: "transitousLock.propose",
        ref: lock.ref,
        submodules: lock.submodules,
        lockedBy: lock.lockedBy,
        ...(lock.comment ? { comment: lock.comment } : {}),
      }),
    );

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

  registerDataManagerRoute(app, "approveTransitBump", async (_req, reply) => {
    return reply
      .code(503)
      .send({ error: "Catalog approval requires paired validation and durable activation" });
  });
}
