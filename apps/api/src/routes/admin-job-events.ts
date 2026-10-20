import { adminJobStreamEventSchemas } from "@openmapx/core/api-contracts";
import type { FastifyInstance } from "fastify";
import { getActivityJob } from "../services/activity-jobs";
import { jobEventBus, type StoredJobEvent, TERMINAL_JOB_STATUSES } from "../services/job-events";
import { requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth.js";
import { registerActivityAdminRoute } from "./admin-activity";

const HEARTBEAT_INTERVAL_MS = 15_000;
const RETRY_HINT_MS = 2_000;
/** Bound both deferred snapshot delivery and unflushed writes per viewer. */
const MAX_PENDING_EVENTS = 200;

function wire<T>(value: T): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error("Invalid administration stream event");
  }
}

function frame(
  id: number | null,
  event: keyof typeof adminJobStreamEventSchemas,
  data: unknown,
): string {
  const parsed = adminJobStreamEventSchemas[event].safeParse(data);
  if (!parsed.success) throw new Error("Invalid administration stream event");
  return `${id === null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(parsed.data)}\n\n`;
}

/** Live application jobs; browser EventSource owns reconnects and the connection lifetime. */
export async function adminJobEventsRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  registerActivityAdminRoute(
    app,
    "getAdminActivityJobStreamMetrics",
    async () => jobEventBus.metrics,
  );
  registerActivityAdminRoute(app, "streamAdminActivityJobEvents", async (request, reply) => {
    const jobId = request.params.id;
    let disconnected = reply.raw.destroyed;
    const earlyClose = () => {
      disconnected = true;
    };
    reply.raw.once("close", earlyClose);
    let job: Awaited<ReturnType<typeof getActivityJob>>;
    try {
      job = await getActivityJob(jobId, "application");
    } finally {
      reply.raw.removeListener("close", earlyClose);
    }
    if (disconnected) {
      reply.hijack();
      reply.raw.end();
      return reply;
    }
    if (!job) return reply.status(404).send({ error: "Job not found" });
    // Fail as JSON before hijacking whenever the initial durable state is unusable.
    const initial = adminJobStreamEventSchemas.snapshot.safeParse({ job: wire(job) });
    if (!initial.success) throw new Error("Invalid administration stream snapshot");
    // The registrar has already parsed both numeric forms. Header wins on reconnect.
    const cursor =
      (request.headers["last-event-id"] as unknown as number | undefined) ?? request.query.cursor;

    reply.hijack();
    const res = reply.raw;
    const metrics = jobEventBus.metrics;
    metrics.activeStreams += 1;
    let closed = false;
    let pendingWrites = 0;
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe = () => {};
    let primed = false;
    const backlog: StoredJobEvent[] = [];

    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      backlog.length = 0;
      request.raw.removeListener("close", close);
      res.removeListener("close", close);
      res.removeListener("error", close);
      metrics.activeStreams -= 1;
      res.end();
    };
    const overflow = () => {
      if (closed) return;
      metrics.droppedEvents += 1;
      try {
        res.write(frame(null, "overflow", { reason: "slow consumer" }));
      } finally {
        close();
      }
    };
    const write = (chunk: string): boolean => {
      if (closed) return false;
      try {
        if (res.write(chunk)) pendingWrites = 0;
        else if (++pendingWrites > MAX_PENDING_EVENTS) {
          overflow();
          return false;
        }
        return true;
      } catch {
        close();
        return false;
      }
    };
    const deliver = (stored: StoredJobEvent) => {
      if (closed) return;
      try {
        // Qualify before buffering as well as writing; the bus catches listener exceptions.
        const chunk = frame(stored.cursor, stored.event.type, wire(stored.event));
        if (!primed) {
          if (backlog.length >= MAX_PENDING_EVENTS) overflow();
          else backlog.push(stored);
          return;
        }
        jobEventBus.recordDelivery(stored);
        if (!write(chunk)) return;
        if (stored.event.type === "status" && TERMINAL_JOB_STATUSES.has(stored.event.status)) {
          write(frame(null, "end", { status: stored.event.status }));
          close();
        }
      } catch {
        close();
      }
    };

    request.raw.on("close", close);
    res.on("close", close);
    res.on("error", close);
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (!write(`retry: ${RETRY_HINT_MS}\n\n`)) return reply;
      unsubscribe = jobEventBus.subscribe(jobId, deliver);
      if (closed) {
        unsubscribe();
        return reply;
      }
      const replay = cursor !== undefined && cursor > 0 ? jobEventBus.history(jobId, cursor) : null;
      if (replay) {
        metrics.reconnects += 1;
        metrics.backfilledEvents += replay.length;
        primed = true;
        for (const stored of replay) {
          deliver(stored);
          if (closed) return reply;
        }
        if (TERMINAL_JOB_STATUSES.has(initial.data.job.status) && !closed) {
          write(frame(null, "end", { status: initial.data.job.status }));
          close();
        }
      } else {
        if (cursor !== undefined && cursor > 0) metrics.snapshotFallbacks += 1;
        // Events after this cursor wait until the re-read snapshot has been written.
        const snapshotCursor = jobEventBus.latestCursor(jobId);
        const snapshot = (await getActivityJob(jobId, "application")) ?? job;
        if (closed) return reply;
        const data = { job: wire(snapshot) };
        if (!write(frame(snapshotCursor, "snapshot", data))) return reply;
        if (TERMINAL_JOB_STATUSES.has(snapshot.status)) {
          write(frame(null, "end", { status: snapshot.status }));
          close();
        }
        primed = true;
        for (const stored of backlog.splice(0)) {
          if (closed) break;
          if (stored.cursor > snapshotCursor) deliver(stored);
        }
      }
      if (!closed) {
        heartbeat = setInterval(() => {
          write(": heartbeat\n\n");
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();
      }
    } catch {
      // No error payload after hijacking, and no exception can strand a viewer.
      close();
    }
    return reply;
  });
}
