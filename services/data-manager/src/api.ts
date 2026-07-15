import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseTransitSource } from "@openmapx/transitous-core";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { convertPbfToBz2, convertPbfToBz2ForRegion } from "./jobs/convert-overpass.js";
import { downloadGtfs, type FeedDescriptor } from "./jobs/download-gtfs.js";
import { downloadOsm } from "./jobs/download-osm.js";
import { downloadStyle } from "./jobs/download-style.js";
import { applyHardlinkPlan, type HardlinkEntry } from "./jobs/link.js";
import { conflateOverture } from "./jobs/overture/conflate.js";
import { extractOsmPois } from "./jobs/overture/extract-osm-pois.js";
import { ingestOverture } from "./jobs/overture/ingest.js";
import { assertValidRegion, pullOverture } from "./jobs/overture/pull.js";
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
  parseRefShaPair,
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

export function registerApi(app: FastifyInstance, opts: ApiOptions = {}): void {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "/data";
  const repoRoot = opts.repoRoot ?? process.env.OPENMAPX_ROOT_DIR ?? "";
  const singleFlight = opts.singleFlight ?? getSingleFlightController();
  const store = new StateStore(dataDir);
  const operationsPolicy =
    opts.operationsPolicy ??
    resolveOperationsProfileFromEnv(process.env, { allowEmptyRegional: true });

  app.get("/status", async () => ({
    ok: true,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    dataDir,
  }));

  app.get("/datasets", async () => ({ datasets: store.getAll() }));

  app.get("/transit/profile", async () => ({ policy: publicOperationsPolicy(operationsPolicy) }));

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
      const result = await pullOverture({
        region,
        dataDir,
        onProgress: (msg) => writeLine({ event: "progress", message: msg }),
      });
      writeLine({ event: "done", ok: true, path: result });
    } catch (err) {
      writeLine({ event: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });

  app.post<{ Body: { region: string } }>("/overture/ingest", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

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
      await ingestOverture({
        region,
        dataDir,
        onProgress: (msg) => writeLine({ event: "progress", message: msg }),
      });
      writeLine({ event: "done", ok: true });
    } catch (err) {
      writeLine({ event: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });

  app.post<{ Body: { region: string } }>("/overture/extract", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

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
      await extractOsmPois({
        region,
        dataDir,
        onProgress: (msg) => writeLine({ event: "progress", message: msg }),
      });
      writeLine({ event: "done", ok: true });
    } catch (err) {
      writeLine({ event: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });

  app.post<{ Body: { region: string } }>("/overture/conflate", async (req, reply) => {
    const { region } = req.body;
    if (!region) throw new Error("region required");
    assertValidRegion(region);

    const ollamaUrl = process.env.OLLAMA_URL || "http://local-ai:11434";

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
      const result = await conflateOverture({
        region,
        ollamaUrl,
        useEmbeddings: false,
        onProgress: (msg) => writeLine({ event: "progress", message: msg }),
      });
      writeLine({ event: "done", ok: true, ...result });
    } catch (err) {
      writeLine({ event: "error", message: (err as Error).message });
    } finally {
      reply.raw.end();
    }
  });

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

    // Kick off the pipeline async — the route returns 202 immediately.
    const jobId = start.jobId;
    const jobLog = asJobLogger(jobChildLogger({ job: "transitous-sync", jobId, trigger: "api" }));
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
        });
        const result = await runTransitousPipeline(ctx);
        await finalizeJobRow(jobId, result.finalStatus);
        app.log.info({ jobId, finalStatus: result.finalStatus }, "transitous-api: sync finished");
      } catch (err) {
        app.log.error({ jobId, err }, "transitous-api: sync threw");
        try {
          await finalizeJobRow(jobId, "error");
        } catch {
          // Swallow — the row will look stuck at "running" until the next
          // restart-time janitor pass.
        }
      } finally {
        singleFlight.markSyncFinished();
      }
    })();

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
    if (!existsSync(join(catalogDir, ".git"))) {
      reply.code(409);
      return {
        ok: false,
        error: "catalog-not-cloned",
        message: `Transitous catalog not found at ${catalogDir}; run a sync first to clone it.`,
      };
    }

    try {
      await execa("git", ["-C", catalogDir, "fetch", "origin", branch], { stdio: "pipe" });
    } catch (err) {
      reply.code(502);
      return {
        ok: false,
        error: "git-fetch-failed",
        message: (err as Error).message,
      };
    }

    const fetchSha = (
      await execa("git", ["-C", catalogDir, "rev-parse", `origin/${branch}`], { stdio: "pipe" })
    ).stdout.trim();

    // `git ls-tree <ref> <path>` returns "<mode> commit <sha>\t<path>" for a
    // submodule entry; rev-parse on the same ref:path would resolve a tree.
    const submoduleEntry = (
      await execa("git", ["-C", catalogDir, "ls-tree", `origin/${branch}`, "transitland-atlas"], {
        stdio: "pipe",
      })
    ).stdout;
    const submoduleMatch = submoduleEntry.match(/^\d+\s+commit\s+([0-9a-f]{40})\s/i);
    if (!submoduleMatch) {
      reply.code(500);
      return {
        ok: false,
        error: "submodule-resolution-failed",
        message: "Could not resolve transitland-atlas submodule SHA",
      };
    }
    const submoduleSha = submoduleMatch[1];

    const existing = readTransitousLock(repoRoot);
    const previousSha = existing ? parseRefShaPair(existing.ref).sha : null;
    if (previousSha === fetchSha && !force) {
      return {
        ok: true,
        unchanged: true,
        ref: `${branch}@${fetchSha}`,
        previousRef: existing?.ref ?? null,
      };
    }

    const lock: TransitousLock = {
      ref: `${branch}@${fetchSha}`,
      submodules: { "transitland-atlas": submoduleSha },
      lockedAt: new Date().toISOString(),
      lockedBy,
      comment:
        "Pinned commit of public-transport/transitous consumed by services/data-manager. Bumped via POST /transit/bump.",
    };
    writeTransitousLockProposal(repoRoot, lock);

    return {
      ok: true,
      unchanged: false,
      proposed: true,
      ref: lock.ref,
      previousRef: existing?.ref ?? null,
      submoduleSha,
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
