import { createReadStream } from "node:fs";
import { join } from "node:path";
import { type OfflinePackageRequest, parseOfflinePackageRequest } from "@openmapx/core";
import { feedState } from "@openmapx/db-schema";
import { parseTransitSource } from "@openmapx/transitous-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { db, sql } from "./db/index.js";
import { convertPbfToBz2, convertPbfToBz2ForRegion } from "./jobs/convert-overpass.js";
import { downloadFonts } from "./jobs/download-fonts.js";
import { downloadOsm } from "./jobs/download-osm.js";
import { applyHardlinkPlan, type HardlinkEntry } from "./jobs/link.js";
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
import { createSearchIndexOperationLock } from "./jobs/search-index/operation-lock.js";
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
import {
  type MotisOperationsPolicy,
  publicOperationsPolicy,
  resolveOperationsProfileFromEnv,
} from "./jobs/transitous/operations-profile.js";
import {
  getOperatorFeedRelayStore,
  OPERATOR_FEED_RELAY_PATH,
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
import { StateStore } from "./state.js";
import {
  listPinnedTransitCatalog,
  listTransitSources,
  prepareAddTransitSource,
  prepareEnableTransitSource,
  prepareRemoveTransitSource,
  resolveTransitOverlayPath,
  type TransitFeedStateEvidence,
  TransitSourceError,
  type TransitSourceLifecycle,
} from "./transit-sources.js";

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
  /**
   * Runs the predicted-traffic bake. Wired in `index.ts` only when
   * `OPENCONDITIONS_URL` is configured, so the route can answer 501 rather than
   * pretending to work on a deployment without OpenConditions.
   */
  bakePredicted?: () => Promise<BakePredictedResult>;
  /** Offline package generator initialized by the process entrypoint. */
  offlinePackages?: OfflinePackageGenerator;
  /** Search-index database/test seam. */
  searchIndexSql?: postgres.Sql;
  /** Test seam for the country-scale OSM search-index build. */
  buildSearchIndex?: (opts: BuildOsmSearchIndexOptions) => Promise<SearchIndexBuildResult>;
  /** Process startup readiness; omitted by isolated route tests, which are ready immediately. */
  readiness?: () => DataManagerReadinessSnapshot;
  /** Process-wide one-run relay shared with the Transitous pipeline. */
  operatorFeedRelay?: OperatorFeedRelayStore;
}

const startedAt = Date.now();

// Conservative git ref-name shape. Blocks option injection (leading "-"),
// path traversal ("..") and refspec magic ("@{", "~", "^", ":", whitespace,
// control chars) while allowing the slugs/branches the catalog actually uses
// (e.g. "main", "release/2026-06", "feature/x-y").
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const LINK_ENTRY_SCHEMA = {
  type: "object",
  required: ["source", "target", "consumerService", "dataType"],
  additionalProperties: false,
  properties: {
    source: { type: "string", minLength: 1, maxLength: 1024 },
    target: { type: "string", minLength: 1, maxLength: 1024 },
    consumerService: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    dataType: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    instance: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    targetFilename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
  },
} as const;

const LINK_BODY_SCHEMA = {
  type: "object",
  required: ["plan"],
  additionalProperties: false,
  properties: {
    plan: { type: "array", maxItems: 2000, items: LINK_ENTRY_SCHEMA },
    prune: { type: "boolean" },
  },
} as const;

const LINK_BODY_KEYS = ["plan", "prune"] as const;
const LINK_ENTRY_KEYS = [
  "source",
  "target",
  "consumerService",
  "dataType",
  "instance",
  "targetFilename",
] as const;

function hasUnexpectedKeys(value: unknown, allowed: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => !allowed.includes(key))
  );
}

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

  app.get("/offline/packages/capability", async (_request, reply) => {
    return reply.send(await generator.getCapability());
  });

  app.post<{ Body: OfflinePackageRequest }>("/offline/packages/prepare", async (request, reply) => {
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

  app.get<{ Params: { jobId: string } }>(
    "/offline/packages/jobs/:jobId",
    async (request, reply) => {
      const owner = principal(request);
      if (!owner) {
        return reply.code(400).send({
          ok: false,
          errorCode: "invalid-principal",
          errorMessage: "Exactly one valid offline package principal is required",
        });
      }
      const result = await generator.getJob(owner, request.params.jobId);
      if (!result)
        return reply.code(404).send({ ok: false, error: "offline package job not found" });
      return reply.send(result);
    },
  );

  app.get<{ Params: { packageId: string } }>(
    "/offline/packages/:packageId/manifest",
    async (request, reply) => {
      if (!isContentAddressedPackageId(request.params.packageId)) {
        return reply.code(400).send({ ok: false, error: "invalid offline package id" });
      }
      const manifest = await generator.getManifest(request.params.packageId);
      if (!manifest) return reply.code(404).send({ ok: false, error: "offline package not found" });
      return reply.send(manifest);
    },
  );

  const serveGlyph = async (
    request: FastifyRequest<{ Params: { version: string; "*": string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const glyph = /^([^/]+)\/(\d+-\d+)\.pbf$/.exec(request.params["*"] ?? "");
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.params.version) || !glyph) {
      return reply.code(400).send({ ok: false, error: "invalid offline package glyph identity" });
    }
    const asset = await generator.openGlyph(request.params.version, glyph[1], glyph[2]);
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

  app.get<{ Params: { version: string } }>(
    "/offline/packages/glyphs/:version/catalog.json",
    async (request, reply) => {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.params.version)) {
        return reply.code(400).send({ ok: false, error: "invalid offline glyph version" });
      }
      const catalog = await generator.glyphCatalog(request.params.version);
      if (!catalog) return reply.code(404).send({ ok: false, error: "offline glyphs not found" });
      return reply.header("Cache-Control", "public, max-age=31536000, immutable").send(catalog);
    },
  );

  app.head<{ Params: { version: string; "*": string } }>(
    "/offline/packages/glyphs/:version/*",
    serveGlyph,
  );
  app.get<{ Params: { version: string; "*": string } }>(
    "/offline/packages/glyphs/:version/*",
    serveGlyph,
  );

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

  app.head<{ Params: { packageId: string } }>("/offline/packages/:packageId/archive", serveArchive);
  app.get<{ Params: { packageId: string } }>("/offline/packages/:packageId/archive", serveArchive);
}

export function registerApi(app: FastifyInstance, opts: ApiOptions = {}): void {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "/data";
  const repoRoot = opts.repoRoot ?? process.env.OPENMAPX_ROOT_DIR ?? "";
  const singleFlight = opts.singleFlight ?? getSingleFlightController();
  const store = new StateStore(dataDir);
  const searchIndexSql = opts.searchIndexSql ?? sql;
  const searchIndexRuntimeState = createSearchIndexRuntimeState();
  const searchIndexOperationLock = createSearchIndexOperationLock(searchIndexSql);
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
          repoRoot,
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

  app.get("/live", async () => ({ ok: true }));

  app.get<{ Params: { handle: string } }>(
    `${OPERATOR_FEED_RELAY_PATH}/:handle`,
    async (req, reply) => {
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
    },
  );

  app.get("/status", async (_req, reply) => {
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
    const parseCount = (raw: string | undefined, fallback: number): number => {
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

  app.get("/transit/catalog", async (_req, reply) => {
    try {
      return { sources: listPinnedTransitCatalog(catalogDir, operationsPolicy.countries) };
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

  app.delete<{
    Params: { sourceId: string };
    Body?: { idempotencyKey?: string; triggeredBy?: string };
  }>("/transit/sources/:sourceId", async (req, reply) => {
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

  app.post<{
    Params: { sourceId: string };
    Body?: { idempotencyKey?: string; triggeredBy?: string };
  }>("/transit/sources/:sourceId/enable", async (req, reply) => {
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

  // Single-flight: the bake shells out to a slow tile-rewriting tool and
  // restarts Valhalla, so two concurrent runs would fight over the same tiles.
  let bakeInFlight = false;

  app.post("/traffic/predicted/bake", async (_req, reply) => {
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

  app.post<{ Body: { region: string } }>("/download/osm", async (req, reply) => {
    const { region } = req.body ?? {};
    if (!region || typeof region !== "string") throw new Error("region required");
    // Same Geofabrik path shape the Overture routes enforce — the region becomes
    // both a download URL segment and a local filename.
    assertValidRegion(region);

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

  app.get("/search-index/status", async (_req, reply) => {
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

  app.post<{ Body: { region: string } }>("/search-index/build", async (req, reply) => {
    const { region } = req.body ?? {};
    if (!region || typeof region !== "string") {
      return reply.code(400).send({ ok: false, error: "region required" });
    }
    assertValidRegion(region);
    const stream = openNdjsonStream(reply);
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

  app.post("/download/fonts", async () => {
    await downloadFonts({ dataDir, store });
    return { ok: true };
  });

  app.post<{ Body: { plan: HardlinkEntry[]; prune?: boolean } }>(
    "/link",
    {
      schema: { body: LINK_BODY_SCHEMA },
      // Fastify's default Ajv removes additional properties before schema
      // validation, so reject them here while the original body is intact.
      preValidation: async (req, reply) => {
        const body = req.body as { plan?: unknown };
        if (hasUnexpectedKeys(body, LINK_BODY_KEYS)) {
          return reply.code(400).send({ error: "unexpected property in link request" });
        }
        if (
          Array.isArray(body?.plan) &&
          body.plan.some((entry) => hasUnexpectedKeys(entry, LINK_ENTRY_KEYS))
        ) {
          return reply.code(400).send({ error: "unexpected property in link plan entry" });
        }
      },
    },
    async (req) => {
      const { plan, prune } = req.body;
      const result = await applyHardlinkPlan(plan, { rootDir: dataDir, prune });
      return { ok: true, ...result };
    },
  );

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
      return undefined;
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
  }>(
    "/transit/sync",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            idempotencyKey: { type: "string", maxLength: 200 },
            triggeredBy: { type: "string", maxLength: 200 },
            countries: {
              type: "array",
              maxItems: 250,
              items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$" },
            },
          },
        },
      },
      // Fastify's default Ajv configuration can coerce a scalar into a
      // one-element array. Preserve the request contract before validation so
      // a caller cannot bypass the array shape check with `countries: "de"`.
      preValidation: async (req, reply) => {
        const body = req.body as unknown;
        if (
          body !== null &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          Object.hasOwn(body, "countries") &&
          !Array.isArray((body as { countries?: unknown }).countries)
        ) {
          return reply.code(400).send({ error: "countries must be an array" });
        }
      },
    },
    async (req, reply) => {
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
    },
  );

  // POST /transit/restart-motis — bounce the primary MOTIS container. Used
  // when a config change requires a full restart rather than the partial
  // reloads the pipeline already performs.
  app.post("/transit/restart-motis", async (_req, reply) => {
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

  app.post<{ Body?: { approveRef?: string; approvedBy?: string } }>(
    "/transit/bump/approve",
    async (req, reply) => {
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
    },
  );
}
