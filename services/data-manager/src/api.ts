import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as observerDelay } from "node:timers/promises";
import {
  type OfflinePackageRequest,
  parseOfflinePackageRequest,
  type TrafficApplicationSnapshot,
} from "@openmapx/core";
import type { PlannedTrafficClosures } from "@openmapx/core/data-manager-contracts";
import {
  type DataExecutionInput,
  type DataExecutionStatus,
  DEFAULT_CATALOG_BRANCH,
  isDataExecutionTerminal,
  normalizeDataExecutionInput,
  type TransitDesiredSourceMutation,
} from "@openmapx/core/data-manager-contracts";
import { RollingStreamBudget } from "@openmapx/core/server";
import { feedState, jobs } from "@openmapx/db-schema";
import { and, desc, sql as drizzleSql, eq, inArray } from "drizzle-orm";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { type CoverageApiOptions, registerCoverageEvidenceRoute } from "./coverage/api.js";
import type { CoverageSnapshotStore } from "./coverage/snapshot-store.js";
import { db, sql } from "./db/index.js";
import { registerAmbientPlacesApi } from "./jobs/ambient-places/api.js";
import {
  type DataExecutionReceiver,
  registerDataExecutionApi,
  TransitScopeRejected,
} from "./jobs/execution/api.js";
import { runLocalDataExecution, startLocalDataExecution } from "./jobs/execution/local.js";
import { DataConfigurationMaintenanceBusy, DataExecutionConflict } from "./jobs/execution/store.js";
import {
  createNotablePlacesRuntimeState,
  getNotablePlacesStatus,
  type NotablePlacesRuntimeState,
} from "./jobs/notable-places/state.js";
import { getOvertureConflationState } from "./jobs/overture/rebuild-links.js";
import { inspectOvertureRecovery } from "./jobs/overture/recovery.js";
import {
  createNotablePlacesOperationLock,
  type SearchIndexOperationLock,
} from "./jobs/search-index/operation-lock.js";
import { createSearchIndexRuntimeState, getSearchIndexStatus } from "./jobs/search-index/state.js";
import type { BakePredictedResult } from "./jobs/traffic/bake-predicted.js";
import { createTransitPreflightController } from "./jobs/transitous/admin-preflight.js";
import { CatalogBumpError } from "./jobs/transitous/catalog-bump.js";
import { resolveTransitOverlayPath } from "./jobs/transitous/internal.js";
import {
  type MotisOperationsPolicy,
  publicOperationsPolicy,
  resolveOperationsProfileFromEnv,
  transitAllowedCountries,
} from "./jobs/transitous/operations-profile.js";
import {
  getOperatorFeedRelayStore,
  OperatorFeedRelayCapabilityError,
  type OperatorFeedRelayStore,
} from "./jobs/transitous/operator-feed-relay.js";
import { runMotisPreflight } from "./jobs/transitous/preflight.js";
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
import { registerDataManagerRoute } from "./route-contract.js";
import { StateStore } from "./state.js";
import {
  listPinnedTransitCatalog,
  listTransitSources,
  prepareAddTransitSource,
  prepareEnableTransitSource,
  prepareRemoveTransitSource,
  prepareSetTransitSourceEnabled,
  type TransitFeedStateEvidence,
  TransitSourceError,
} from "./transit-sources.js";

export interface ApiOptions {
  catalogReview?: Pick<
    ReturnType<typeof import("./jobs/transitous/catalog-review.js").createCatalogReviewService>,
    "resolveCatalogProposal" | "reviewState"
  >;
  executionReceiver?: DataExecutionReceiver;
  dataDir?: string;
  operationsPolicy?: MotisOperationsPolicy;
  /**
   * Runs the predicted-traffic bake. Wired in `service.ts` only when
   * `OPENCONDITIONS_URL` is configured, so the route can answer 501 rather than
   * pretending to work on a deployment without OpenConditions.
   */
  bakePredicted?: () => Promise<BakePredictedResult>;
  /** Latest committed actuation evidence, matched to the actual serving route response. */
  getTrafficConditionsApplied?: () => TrafficApplicationSnapshot;
  /** Bound closures a planned car trip must route around; null while the evidence is stale. */
  getPlannedClosures?: (
    bbox: readonly [number, number, number, number],
    travelAt: number,
  ) => PlannedTrafficClosures | null;
  /** Offline package generator initialized by the process entrypoint. */
  offlinePackages?: OfflinePackageGenerator;
  /** Process-local offline archive delivery budget; tests inject deterministic limits. */
  offlinePackageDeliveryBudget?: RollingStreamBudget;
  /** Test seam for blocked or erroring archive streams. */
  offlinePackageArchiveStream?: (
    path: string,
    options?: { start: number; end: number },
  ) => Readable;
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

const DEFAULT_OFFLINE_DELIVERY_MAX_BYTES = 32_000_000_000;
const DEFAULT_OFFLINE_DELIVERY_WINDOW_MS = 600_000;
const DEFAULT_OFFLINE_DELIVERY_MAX_CONCURRENT = 16;

function envPositiveSafeInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]?.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createOfflinePackageDeliveryBudgetFromEnv(): RollingStreamBudget {
  const maxConcurrent = envPositiveSafeInt(
    "OFFLINE_PACKAGE_DELIVERY_MAX_CONCURRENT",
    DEFAULT_OFFLINE_DELIVERY_MAX_CONCURRENT,
  );
  return new RollingStreamBudget({
    maxBytesPerKey: envPositiveSafeInt(
      "OFFLINE_PACKAGE_DELIVERY_MAX_BYTES",
      DEFAULT_OFFLINE_DELIVERY_MAX_BYTES,
    ),
    windowMs: envPositiveSafeInt(
      "OFFLINE_PACKAGE_DELIVERY_WINDOW_MS",
      DEFAULT_OFFLINE_DELIVERY_WINDOW_MS,
    ),
    maxConcurrentPerKey: maxConcurrent,
    maxConcurrentGlobal: maxConcurrent,
  });
}

function registerOfflinePackageRoutes(
  app: FastifyInstance,
  generator: OfflinePackageGenerator,
  deliveryBudget: RollingStreamBudget,
  archiveStream: (path: string, options?: { start: number; end: number }) => Readable,
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
        error: "Exactly one valid offline package principal is required",
        code: "invalid-principal",
      });
    }
    let body: OfflinePackageRequest;
    try {
      body = parseOfflinePackageRequest(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
        code: "invalid-request",
      });
    }
    try {
      const result = await generator.prepare(owner, body);
      if (result.status === "ready-to-download") return reply.code(200).send(result);
      if (result.status === "preparing") return reply.code(202).send(result);
      const status = result.errorCode === "capacity" ? 409 : 400;
      return reply.code(status).send({ error: result.errorMessage, code: result.errorCode });
    } catch (error) {
      if (error instanceof OfflinePackageCapacityError) {
        reply.header("Retry-After", "30");
        return reply.code(429).send({ error: error.message, code: error.errorCode });
      }
      if (error instanceof OfflinePackagePrincipalQuotaError) {
        reply.header("Retry-After", "30");
        return reply.code(429).send({
          error: error.message,
          code: error.errorCode,
          retryAfterSeconds: 30,
        });
      }
      return reply.code(503).send({
        error: error instanceof Error ? error.message : String(error),
        code: "source-unavailable",
      });
    }
  });

  registerDataManagerRoute(app, "getOfflinePackageJob", async (request, reply) => {
    const owner = principal(request);
    if (!owner) {
      return reply.code(400).send({
        error: "Exactly one valid offline package principal is required",
        code: "invalid-principal",
      });
    }
    const result = await generator.getJob(owner, request.params.jobId);
    if (!result) return reply.code(404).send({ error: "offline package job not found" });
    return reply.send(result);
  });

  registerDataManagerRoute(app, "getOfflinePackageManifest", async (request, reply) => {
    if (!isContentAddressedPackageId(request.params.packageId)) {
      return reply.code(400).send({ error: "invalid offline package id" });
    }
    const manifest = await generator.getManifest(request.params.packageId);
    if (!manifest) return reply.code(404).send({ error: "offline package not found" });
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
    if (!asset) return reply.code(404).send({ error: "offline package glyph not found" });
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
      return reply.code(400).send({ error: "invalid offline glyph version" });
    }
    const catalog = await generator.glyphCatalog(request.params.version);
    if (!catalog) return reply.code(404).send({ error: "offline glyphs not found" });
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
      return reply.code(400).send({ error: "invalid offline package id" });
    }
    const manifest = await generator.getManifest(packageId);
    if (!manifest) return reply.code(404).send({ error: "offline package not found" });
    const total = manifest.archive.byteLength;
    const ifRange = request.headers["if-range"];
    const rangeHeader = request.headers.range;
    const useRange =
      typeof rangeHeader === "string" && (!ifRange || ifRange === manifest.archive.etag);
    const range = useRange && rangeHeader ? parseByteRange(rangeHeader, total) : undefined;
    if (useRange && rangeHeader && !range) {
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
    } else {
      headers["Content-Length"] = String(total);
    }
    const statusCode = range ? 206 : 200;

    if (request.method === "HEAD") {
      for (const [name, value] of Object.entries(headers)) reply.header(name, value);
      return reply.code(statusCode).send();
    }

    const admission = deliveryBudget.tryAcquire("offline-package-delivery");
    if (!admission.allowed) {
      reply.header("Retry-After", String(admission.retryAfterSeconds));
      return reply.code(503).send({ error: "offline package delivery capacity exceeded" });
    }
    const responseBytes = range ? range.end - range.start + 1 : total;
    const byteAdmission = admission.lease.consume(responseBytes);
    if (!byteAdmission.allowed) {
      admission.lease.release();
      reply.header("Retry-After", String(byteAdmission.retryAfterSeconds));
      return reply.code(503).send({ error: "offline package delivery byte budget exceeded" });
    }

    let archive: Awaited<ReturnType<OfflinePackageGenerator["openArchive"]>>;
    try {
      archive = await generator.openArchive(packageId);
      if (!archive) {
        admission.lease.release();
        return reply.code(404).send({ error: "offline package not found" });
      }
      const stream = archiveStream(
        archive.path,
        range ? { start: range.start, end: range.end } : undefined,
      );
      const release = () => {
        archive?.release();
        admission.lease.release();
      };
      const cancelStream = () => {
        if (!stream.destroyed) stream.destroy(new Error("Offline package client disconnected"));
        release();
      };
      stream.once("close", release);
      stream.once("error", release);
      request.raw.once("aborted", cancelStream);
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) cancelStream();
        else release();
      });
      for (const [name, value] of Object.entries(headers)) reply.header(name, value);
      return reply.code(statusCode).send(stream);
    } catch (error) {
      archive?.release();
      admission.lease.release();
      throw error;
    }
  };

  registerDataManagerRoute(app, "headOfflinePackageArchive", serveArchive);
  registerDataManagerRoute(app, "getOfflinePackageArchive", serveArchive);
}

/**
 * Answers a failed transit-source read or change. A `TransitSourceError` carries
 * its status, a user-safe text and, for a refused action, its code. Any other
 * failure of the route is logged and answers a 500 with a fixed text, so a store
 * or database message never reaches the client. Request errors that already
 * carry an HTTP status, such as an oversized body, keep Fastify's reply.
 */
function transitSourceErrorReply(error: Error, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof TransitSourceError) {
    return reply
      .code(error.statusCode)
      .send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  if ("statusCode" in error) throw error;
  request.log.error({ err: error }, "transit-sources: request failed");
  return reply.code(500).send({ error: "Transit source request failed" });
}

/** Runs a source change's prepare step; a failure it does not classify is the caller's error. */
function prepareSourceChange<T>(prepare: () => T): T {
  try {
    return prepare();
  } catch (error) {
    throw error instanceof TransitSourceError
      ? error
      : new TransitSourceError((error as Error).message);
  }
}

export function registerApi(app: FastifyInstance, opts: ApiOptions = {}): void {
  registerDataExecutionApi(app, opts.executionReceiver);
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "/data";
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
  const transitPreflight = createTransitPreflightController({ dataDir, policy: operationsPolicy });
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

  if (opts.offlinePackages) {
    registerOfflinePackageRoutes(
      app,
      opts.offlinePackages,
      opts.offlinePackageDeliveryBudget ?? createOfflinePackageDeliveryBudgetFromEnv(),
      opts.offlinePackageArchiveStream ?? ((path, options) => createReadStream(path, options)),
    );
  }

  async function admitData(
    input: DataExecutionInput,
    source?: { triggeredBy?: string; idempotencyKey?: string },
  ) {
    if (!opts.executionReceiver)
      throw Object.assign(Error("Durable data receiver is unavailable"), { statusCode: 503 });
    return opts.executionReceiver.admitLocal(input, source);
  }
  async function observeData(status: DataExecutionStatus, reply: FastifyReply) {
    const receiver = opts.executionReceiver;
    if (!receiver)
      throw Object.assign(Error("Durable data receiver is unavailable"), { statusCode: 503 });
    const observer = new AbortController(),
      closed = () => observer.abort();
    reply.raw.once("close", closed);
    reply.request.raw.once("aborted", closed);
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
      return current;
    } catch (error) {
      if (!observer.signal.aborted) throw error;
      return undefined;
    } finally {
      reply.raw.removeListener("close", closed);
      reply.request.raw.removeListener("aborted", closed);
    }
  }

  async function reserveSourceMutation(options: {
    triggeredBy: string;
    idempotencyKey?: string;
    sourceId: string;
    action: "add" | "remove" | "enable" | "disable";
    mutation: TransitDesiredSourceMutation;
  }): Promise<
    { ok: true; jobId: string } | { ok: false; status: number; body: Record<string, unknown> }
  > {
    if (!opts.executionReceiver)
      return {
        ok: false,
        status: 503,
        body: { error: "Durable data receiver is unavailable" },
      };
    const input = normalizeDataExecutionInput({
      kind: "transit-sync",
      countries: transitAllowedCountries(operationsPolicy),
      sourceMutation: options.mutation,
    });
    // Desired state is written only by the sync's worker under its admitted
    // target authority, never by this HTTP handler. Admission is exclusive, so
    // a running data job refuses the mutation.
    try {
      const admitted = await opts.executionReceiver.admitLocal(input, {
        triggeredBy: options.triggeredBy,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      return { ok: true, jobId: admitted.id };
    } catch (error) {
      if (
        error instanceof DataConfigurationMaintenanceBusy ||
        error instanceof DataExecutionConflict
      )
        return {
          ok: false,
          status: 409,
          body:
            error instanceof DataExecutionConflict
              ? {
                  error: "This idempotency key was already used for a different change.",
                  code: "duplicate-idempotency-key",
                  existingJobId: null,
                }
              : {
                  error: "Another data job is running. Try again when it finishes.",
                  code: "in-flight",
                  existingJobId: null,
                },
        };
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

  // Transit-source reads and changes answer their refusals through one handler.
  const transitSourceRoute = { errorHandler: transitSourceErrorReply };

  registerDataManagerRoute(
    app,
    "getTransitSources",
    async (req) => {
      const parseCount = (raw: number | undefined, fallback: number): number => {
        const value = Number(raw ?? fallback);
        return Number.isFinite(value) ? value : fallback;
      };
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
        countries: transitAllowedCountries(operationsPolicy),
        feedStates,
        query: {
          search: req.query.search,
          lifecycle: req.query.lifecycle,
          origin: req.query.origin,
          limit: parseCount(req.query.limit, 100),
          offset: parseCount(req.query.offset, 0),
        },
      });
    },
    transitSourceRoute,
  );

  registerDataManagerRoute(
    app,
    "getTransitCatalog",
    async () => ({
      sources: listPinnedTransitCatalog(catalogDir, transitAllowedCountries(operationsPolicy)),
    }),
    transitSourceRoute,
  );

  registerDataManagerRoute(
    app,
    "addTransitSource",
    async (req, reply) => {
      const mutation = prepareSourceChange(() =>
        prepareAddTransitSource({
          catalogDir,
          overlayPath,
          countries: transitAllowedCountries(operationsPolicy),
          expectedSourceRevision: req.body.expectedSourceRevision,
          source: {
            spec: "gtfs",
            type: "http",
            region: req.body.region,
            name: req.body.name,
            url: req.body.url,
            origin: "operator",
            license: req.body.license,
          },
        }),
      );
      const result = await reserveSourceMutation({
        triggeredBy: req.body.triggeredBy ?? "api",
        idempotencyKey: req.body.idempotencyKey,
        sourceId: mutation.sourceId,
        action: "add",
        mutation: {
          action: "add",
          expectedSourceRevision: req.body.expectedSourceRevision,
          source: {
            region: req.body.region,
            name: req.body.name,
            url: req.body.url,
            license: req.body.license,
          },
        },
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply
        .code(202)
        .send({ jobId: result.jobId, sourceId: mutation.sourceId, status: "started" });
    },
    transitSourceRoute,
  );

  registerDataManagerRoute(
    app,
    "removeTransitSource",
    async (req, reply) => {
      const mutation = prepareSourceChange(() =>
        prepareRemoveTransitSource({
          catalogDir,
          overlayPath,
          countries: transitAllowedCountries(operationsPolicy),
          expectedSourceRevision: req.body.expectedSourceRevision,
          sourceId: req.params.sourceId,
        }),
      );
      const result = await reserveSourceMutation({
        triggeredBy: req.body?.triggeredBy ?? "api",
        idempotencyKey: req.body?.idempotencyKey,
        sourceId: mutation.sourceId,
        action: "remove",
        mutation: {
          action: "remove",
          sourceId: mutation.sourceId,
          expectedSourceRevision: req.body.expectedSourceRevision,
        },
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply
        .code(202)
        .send({ jobId: result.jobId, sourceId: mutation.sourceId, status: "started" });
    },
    transitSourceRoute,
  );

  registerDataManagerRoute(
    app,
    "enableTransitSource",
    async (req, reply) => {
      const mutation = prepareSourceChange(() =>
        prepareEnableTransitSource({
          catalogDir,
          overlayPath,
          countries: transitAllowedCountries(operationsPolicy),
          expectedSourceRevision: req.body.expectedSourceRevision,
          sourceId: req.params.sourceId,
        }),
      );
      const result = await reserveSourceMutation({
        triggeredBy: req.body?.triggeredBy ?? "api",
        idempotencyKey: req.body?.idempotencyKey,
        sourceId: mutation.sourceId,
        action: "enable",
        mutation: {
          action: "enable",
          sourceId: mutation.sourceId,
          expectedSourceRevision: req.body.expectedSourceRevision,
        },
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply
        .code(202)
        .send({ jobId: result.jobId, sourceId: mutation.sourceId, status: "started" });
    },
    transitSourceRoute,
  );

  registerDataManagerRoute(
    app,
    "disableTransitSource",
    async (req, reply) => {
      const mutation = prepareSourceChange(() =>
        prepareSetTransitSourceEnabled({
          catalogDir,
          overlayPath,
          countries: transitAllowedCountries(operationsPolicy),
          expectedSourceRevision: req.body.expectedSourceRevision,
          sourceId: req.params.sourceId,
          enabled: false,
        }),
      );
      const result = await reserveSourceMutation({
        triggeredBy: req.body?.triggeredBy ?? "api",
        idempotencyKey: req.body?.idempotencyKey,
        sourceId: mutation.sourceId,
        action: "disable",
        mutation: {
          action: "disable",
          sourceId: mutation.sourceId,
          expectedSourceRevision: req.body.expectedSourceRevision,
        },
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply
        .code(202)
        .send({ jobId: result.jobId, sourceId: mutation.sourceId, status: "started" });
    },
    transitSourceRoute,
  );

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
    return runLocalDataExecution({ kind: "data-reload" }, async () => ({
      ok: true as const,
      ...store.reload(),
    }));
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
    let owned: Awaited<ReturnType<typeof startLocalDataExecution>>;
    try {
      owned = await startLocalDataExecution({ kind: "traffic-predicted" }, opts.bakePredicted);
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

  // Authenticated, uncached: closures a planned trip excludes per request.
  registerDataManagerRoute(app, "getPlannedTrafficClosures", async (req, reply) => {
    if (!opts.getPlannedClosures) {
      reply.code(501);
      return { error: "live traffic not configured" };
    }
    const { west, south, east, north, at } = req.query;
    const planned = opts.getPlannedClosures([west, south, east, north], Date.parse(at));
    reply.header("Cache-Control", "no-store");
    if (!planned) {
      reply.code(503);
      return { error: "road-condition evidence or policy unavailable" };
    }
    return planned;
  });

  registerDataManagerRoute(app, "getSearchIndexStatus", async (_req, reply) => {
    const status = await getSearchIndexStatus({
      dataDir,
      store,
      sql: searchIndexSql,
      runtimeState: searchIndexRuntimeState,
    });
    if (!status) {
      return reply.code(404).send({ error: "osm_search index not built" });
    }
    return reply.send({ ok: true, ...status });
  });

  registerDataManagerRoute(app, "getNotablePlacesStatus", async (_req, reply) => {
    const status = await getNotablePlacesStatus({
      sql: searchIndexSql,
      runtimeState: notablePlaces.runtimeState,
    });
    if (!status) {
      return reply.code(404).send({ error: "notable_places index not built" });
    }
    return reply.send({ ok: true, ...status });
  });

  registerDataManagerRoute(app, "getOvertureRecovery", async (req, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return await inspectOvertureRecovery(sql, dataDir, req.query.region);
    } catch (err) {
      req.log.error({ err }, "Overture prerequisite inspection failed");
      reply.code(503);
      return { error: "Overture prerequisite inspection is unavailable" };
    }
  });

  registerDataManagerRoute(app, "getOvertureStatus", async (_req, reply) => {
    const state = await getOvertureConflationState(sql);
    if (!state) {
      reply.code(404);
      return { error: "overture_places not ingested" };
    }
    const heartbeatAgeMs = Math.max(0, Date.now() - state.updatedAt.getTime());
    return {
      ok: true,
      ...state,
      heartbeatAgeMs,
      stalled: state.status === "running" && heartbeatAgeMs > 30 * 60 * 1000,
    };
  });

  // POST /transit/sync — fire-and-forget Transitous pipeline trigger. Honours
  // the single-flight lock + idempotency key. apps/api proxies user-facing
  // sync requests here.
  registerDataManagerRoute(app, "inspectTransitSyncPreflight", async (req, reply) => {
    try {
      return await transitPreflight.inspect(req.body.countries);
    } catch (error) {
      const e = error as Error & { statusCode?: number; code?: string },
        known = e.code === "preflight_stale",
        status = known ? (e.statusCode ?? 409) : 503;
      return reply.code(status).send({
        error: known
          ? e.message
          : "Transit preview inputs or capacity are unavailable. Check instance status.",
        ...(status === 409 ? { code: "preflight_stale" } : {}),
      });
    }
  });
  registerDataManagerRoute(app, "syncTransit", async (req, reply) => {
    const countries = req.body?.countries ?? transitAllowedCountries(operationsPolicy);
    const reviewed = req.body?.preflightId || req.body?.fingerprint;
    if (req.body?.idempotencyKey && reviewed) {
      const original = await opts.executionReceiver?.observeReviewedTransit?.({
        key: req.body.idempotencyKey,
        countries,
        preflightId: req.body.preflightId ?? "",
        fingerprint: req.body.fingerprint ?? "",
        triggeredBy: req.body.triggeredBy,
      });
      if (original)
        return reply.code(202).send({ ok: true, jobId: original.id, status: "started" });
    }
    let preflight:
      | import("./jobs/transitous/admin-preflight.js").TransitPreflightBinding
      | undefined;
    if (reviewed) {
      try {
        preflight = await transitPreflight.verify({
          countries,
          preflightId: req.body?.preflightId ?? "",
          fingerprint: req.body?.fingerprint ?? "",
        });
      } catch (error) {
        const e = error as Error & { code?: string };
        return e.code === "preflight_stale"
          ? reply.code(409).send({ error: e.message, code: "preflight_stale" })
          : reply.code(503).send({
              error: "Transit preview is unavailable. Check instance status before retrying.",
            });
      }
    }
    let admitted: DataExecutionStatus;
    try {
      admitted = await admitData(
        {
          kind: "transit-sync",
          countries,
          ...(preflight ? { preflight } : {}),
        },
        { triggeredBy: req.body?.triggeredBy, idempotencyKey: req.body?.idempotencyKey },
      );
    } catch (error) {
      if (!(error instanceof TransitScopeRejected)) throw error;
      return reply.code(422).send({ error: error.message, code: error.code });
    }
    return reply.code(202).send({ ok: true, jobId: admitted.id, status: "started" });
  });

  // POST /transit/restart-motis — bounce the primary MOTIS container. Used
  // when a config change requires a full restart rather than the partial
  // reloads the pipeline already performs.
  registerDataManagerRoute(app, "restartMotis", async (_req, reply) => {
    if (!opts.executionReceiver)
      return reply.code(503).send({
        error: "Durable data receiver is unavailable",
        code: "ops-agent-unavailable",
      });
    const admitted = await opts.executionReceiver.admitMaintenance("restart-primary");
    await observeData(admitted, reply);
    if (!reply.raw.destroyed) return { ok: true, status: "restart-initiated" };
    return undefined;
  });

  registerDataManagerRoute(app, "inspectCatalogReview", async (req, reply) => {
    if (!opts.catalogReview || !opts.executionReceiver)
      return reply.code(503).send({ error: "Durable catalog review is unavailable" });
    const proposalId = req.query.proposalId;
    const matching = proposalId
      ? and(
          eq(jobs.executionVersion, 2),
          drizzleSql`${jobs.executionInput}->>'proposalId' = ${proposalId}`,
        )
      : undefined;
    const [executions, validations] = proposalId
      ? await Promise.all([
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(matching, inArray(jobs.kind, ["catalog.validate", "catalog.activate"])))
            .orderBy(desc(jobs.startedAt), desc(jobs.id))
            .limit(1),
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(matching, eq(jobs.kind, "catalog.validate")))
            .orderBy(desc(jobs.startedAt), desc(jobs.id))
            .limit(1),
        ])
      : [[], []];
    const latestValidation = validations[0],
      latest = executions[0];
    const snapshot = await opts.catalogReview.reviewState({
      ...req.query,
      ...(latestValidation ? { validationId: latestValidation.id } : {}),
    });
    return {
      ...snapshot,
      execution: latest ? await opts.executionReceiver.inspect(latest.id) : null,
    };
  });

  // POST /transit/bump — propose a new pin set. It never activates the lock;
  // operators must review diffs/build the inactive slot before approval.
  registerDataManagerRoute(app, "proposeTransitBump", async (req, reply) => {
    if (!opts.catalogReview)
      return reply.code(503).send({ error: "Paired catalog resolver is unavailable" });
    try {
      const previous = await runOpsOperation({ kind: "catalogPins.inspect" });
      const proposal = await opts.catalogReview.resolveCatalogProposal({
        branch: req.body?.branch?.trim() || DEFAULT_CATALOG_BRANCH,
        proposalId: req.body?.proposalId,
      });
      return {
        ok: true,
        unchanged: false,
        proposed: true,
        proposalId: proposal.proposalId,
        catalogRevisionId: proposal.pins.generationId,
        ref: proposal.pins.transitous.ref,
        previousRef: previous.active?.transitous.ref ?? null,
        submoduleSha: proposal.pins.transitous.submodules["transitland-atlas"]!,
        lockedAt: proposal.pins.transitous.lockedAt,
        lockedBy: proposal.pins.transitous.lockedBy,
      };
    } catch (err) {
      if (err instanceof CatalogBumpError) {
        const status =
          err.code === "catalog-not-cloned" ? 409 : err.code === "git-fetch-failed" ? 502 : 500;
        return reply.code(status).send({ error: err.code });
      }
      throw err;
    }
  });

  registerDataManagerRoute(app, "approveTransitBump", async (_req, reply) => {
    return reply
      .code(503)
      .send({ error: "Catalog approval requires paired validation and durable activation" });
  });
}
