import type { FastifyInstance } from "fastify";
import { type ActivityJobSource, getActivityJob } from "../services/activity-jobs";
import { jobEventBus, type StoredJobEvent, TERMINAL_JOB_STATUSES } from "../services/job-events";
import { requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const RETRY_HINT_MS = 2_000;
/** Unflushed writes tolerated before a slow viewer is disconnected. */
const MAX_PENDING_WRITES = 200;

function parseCursor(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function frame(id: number | null, event: string, data: unknown): string {
  const lines = [] as string[];
  if (id !== null) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * Live job state, progress, and log events over Server-Sent Events.
 *
 * Cursors are per-job and monotonic. A viewer reconnects with the last id it
 * saw; if the bus still holds those events they are replayed, otherwise the
 * viewer receives a fresh database snapshot and continues from the current
 * cursor. Terminal jobs end the stream explicitly so the browser stops
 * reconnecting.
 */
export async function adminJobEventsRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  app.get("/admin/jobs/stream-metrics", async () => jobEventBus.metrics);

  app.get<{ Params: { id: string }; Querystring: { source?: ActivityJobSource; cursor?: string } }>(
    "/admin/jobs/:id/events",
    async (request, reply) => {
      const source = request.query.source ?? "application";
      if (source !== "application") {
        return reply.status(400).send({ error: "Only application jobs stream events" });
      }
      const jobId = request.params.id;
      const job = await getActivityJob(jobId, source);
      if (!job) return reply.status(404).send({ error: "Job not found" });

      const headerCursor = parseCursor(request.headers["last-event-id"]);
      const cursor = headerCursor ?? parseCursor(request.query.cursor);

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`retry: ${RETRY_HINT_MS}\n\n`);

      const metrics = jobEventBus.metrics;
      metrics.activeStreams += 1;
      let closed = false;
      let pendingWrites = 0;
      let heartbeat: NodeJS.Timeout | null = null;
      let unsubscribe = () => {};

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        metrics.activeStreams -= 1;
        res.end();
      };

      const write = (chunk: string): boolean => {
        if (closed) return false;
        const flushed = res.write(chunk);
        if (flushed) {
          pendingWrites = 0;
        } else {
          pendingWrites += 1;
          if (pendingWrites > MAX_PENDING_WRITES) {
            metrics.droppedEvents += 1;
            res.write(frame(null, "overflow", { reason: "slow consumer" }));
            close();
            return false;
          }
        }
        return true;
      };

      // Live events that arrive before the replay or snapshot has been written
      // wait here so the viewer always has a base state to apply them to.
      let primed = false;
      const backlog: StoredJobEvent[] = [];
      const deliver = (stored: StoredJobEvent) => {
        if (!primed) {
          backlog.push(stored);
          return;
        }
        if (!write(frame(stored.cursor, stored.event.type, stored.event))) return;
        if (stored.event.type === "status" && TERMINAL_JOB_STATUSES.has(stored.event.status)) {
          write(frame(null, "end", { status: stored.event.status }));
          close();
        }
      };

      request.raw.on("close", close);
      unsubscribe = jobEventBus.subscribe(jobId, deliver);

      const replay = cursor !== null && cursor > 0 ? jobEventBus.history(jobId, cursor) : null;
      if (replay) {
        metrics.reconnects += 1;
        metrics.backfilledEvents += replay.length;
        primed = true;
        for (const stored of replay) {
          deliver(stored);
          if (closed) return reply;
        }
        if (TERMINAL_JOB_STATUSES.has(job.status) && !closed) {
          // The terminal status was published before the viewer reconnected
          // but has already left the ring; the snapshot below would be
          // wasteful, so end on the durable status instead.
          if (replay.at(-1)?.event.type !== "status") {
            write(frame(null, "end", { status: job.status }));
            close();
          }
        }
      } else {
        if (cursor !== null && cursor > 0) metrics.snapshotFallbacks += 1;
        // Capture the cursor before re-reading the row. Every event published
        // after this point is replayed from the backlog; every event before it
        // is already reflected in the rows the snapshot carries. An event that
        // lands between the two reads is delivered twice, which the viewer's
        // merge treats as a no-op.
        const snapshotCursor = jobEventBus.latestCursor(jobId);
        const snapshot = (await getActivityJob(jobId, source)) ?? job;
        if (closed) return reply;
        write(frame(snapshotCursor, "snapshot", { job: snapshot }));
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
      return reply;
    },
  );
}
