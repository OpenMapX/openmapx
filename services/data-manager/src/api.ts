import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { FastifyInstance } from "fastify";
import { convertPbfToBz2, convertPbfToBz2ForRegion } from "./jobs/convert-overpass.js";
import { downloadGtfs, type FeedDescriptor } from "./jobs/download-gtfs.js";
import { downloadOsm } from "./jobs/download-osm.js";
import { downloadStyle } from "./jobs/download-style.js";
import { applyHardlinkPlan, type HardlinkEntry } from "./jobs/link.js";
import {
  buildJobContext,
  runTransitousPipeline,
  toDownloadGtfsResult,
} from "./jobs/transitous/index.js";
import { parseTransitousCountriesEnv } from "./jobs/transitous/internal.js";
import { PRIMARY_CONTAINER } from "./jobs/transitous/motis-containers.js";
import { finalizeJobRow, makePersistingOnStageComplete } from "./jobs/transitous/persistence.js";
import { getSingleFlightController } from "./jobs/transitous/runtime.js";
import type { SingleFlightController } from "./jobs/transitous/single-flight.js";
import { StateStore } from "./state.js";
import {
  parseRefShaPair,
  readTransitousLock,
  type TransitousLock,
  writeTransitousLock,
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
      let result: Awaited<ReturnType<typeof downloadGtfs>>;
      if (useTransitousPipeline) {
        const ctx = buildJobContext({
          dataDir,
          store,
          countries,
          repoRoot: process.env.OPENMAPX_ROOT_DIR,
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
    const countries = body.countries ?? parseTransitousCountriesEnv();
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
    const persistingHook = makePersistingOnStageComplete(jobId, {
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
      error: (m) => app.log.error(m),
    });

    void (async () => {
      try {
        const ctx = buildJobContext({
          dataDir,
          store,
          countries,
          repoRoot,
          jobId,
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

  // POST /transit/bump — fetch upstream Transitous catalog ref and write a
  // new lockfile. This is admin-only at the apps/api layer (token clients
  // are rejected upstream) so the data-manager just performs the mechanical
  // git work without re-checking auth.
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
    writeTransitousLock(repoRoot, lock);

    return {
      ok: true,
      unchanged: false,
      ref: lock.ref,
      previousRef: existing?.ref ?? null,
      submoduleSha,
      lockedAt: lock.lockedAt,
      lockedBy: lock.lockedBy,
    };
  });
}
