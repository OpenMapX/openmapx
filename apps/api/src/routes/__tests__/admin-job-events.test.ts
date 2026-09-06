import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers.js";

const { requireAdmin: mockRequireAdmin } = installAdminRouteMocks();

const mockGetActivityJob = vi.fn();
vi.mock("../../services/activity-jobs.js", () => ({
  getActivityJob: (...args: unknown[]) => mockGetActivityJob(...args),
}));

const { jobEventBus } = await import("../../services/job-events.js");
const { adminJobEventsRoute } = await import("../admin-job-events.js");

interface ParsedFrame {
  id?: number;
  event: string;
  data: unknown;
}

function parseSse(body: string): ParsedFrame[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(":") && !block.startsWith("retry:"))
    .map((block) => {
      const frame: ParsedFrame = { event: "message", data: null };
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
      }
      return frame;
    });
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    source: "application",
    id: "job-1",
    type: "data.operation",
    status: "running",
    payload: { operation: "link" },
    result: null,
    error: null,
    progress: 10,
    createdBy: "admin",
    actorLabel: "Administrator",
    createdAt: "2026-09-06T08:00:00.000Z",
    startedAt: "2026-09-06T08:00:01.000Z",
    finishedAt: null,
    cancelable: true,
    logs: [],
    stages: [],
    ...overrides,
  };
}

function logEvent(seq: number) {
  return {
    type: "log" as const,
    id: `log-${seq}`,
    seq,
    stream: "stdout",
    line: `line ${seq}`,
    createdAt: "2026-09-06T08:00:02.000Z",
  };
}

let app: FastifyInstance;
let jobCounter = 0;
function nextJobId() {
  jobCounter += 1;
  return `job-${jobCounter}`;
}

beforeAll(async () => {
  app = await createAdminTestApp(adminJobEventsRoute);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mockGetActivityJob.mockReset();
});

describe("GET /admin/jobs/:id/events", () => {
  it("rejects data-manager sources and unknown jobs", async () => {
    mockGetActivityJob.mockResolvedValue(null);
    const dm = await app.inject({ method: "GET", url: "/admin/jobs/x/events?source=data-manager" });
    expect(dm.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/admin/jobs/x/events" });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects unauthenticated viewers before streaming", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const res = await app.inject({ method: "GET", url: "/admin/jobs/x/events" });
    expect(res.statusCode).toBe(401);
  });

  it("sends a snapshot then ends immediately for a finished job", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id, status: "success", progress: 100 }));
    const res = await app.inject({ method: "GET", url: `/admin/jobs/${id}/events` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const frames = parseSse(res.body);
    expect(frames.map((frame) => frame.event)).toEqual(["snapshot", "end"]);
    expect(frames[0]?.id).toBe(0);
    expect((frames[0]?.data as { job: { status: string } }).job.status).toBe("success");
    expect(frames[1]?.data).toEqual({ status: "success" });
  });

  it("streams live events after the snapshot and ends on a terminal status", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id }));
    setTimeout(() => {
      jobEventBus.publish(id, logEvent(0));
      jobEventBus.publish(id, { type: "progress", progress: 50 });
      jobEventBus.publish(id, { type: "status", status: "success", progress: 100 });
    }, 20);
    const res = await app.inject({ method: "GET", url: `/admin/jobs/${id}/events` });
    const frames = parseSse(res.body);
    expect(frames.map((frame) => frame.event)).toEqual([
      "snapshot",
      "log",
      "progress",
      "status",
      "end",
    ]);
    expect(frames.slice(1, 4).map((frame) => frame.id)).toEqual([1, 2, 3]);
    expect(frames[1]?.data).toMatchObject({ line: "line 0", seq: 0 });
  });

  it("backfills from Last-Event-ID when the ring still has the events", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id }));
    jobEventBus.publish(id, logEvent(0));
    jobEventBus.publish(id, logEvent(1));
    const before = { ...jobEventBus.metrics };
    setTimeout(() => {
      jobEventBus.publish(id, { type: "status", status: "failed", error: "boom" });
    }, 20);
    const res = await app.inject({
      method: "GET",
      url: `/admin/jobs/${id}/events`,
      headers: { "last-event-id": "1" },
    });
    const frames = parseSse(res.body);
    expect(frames.map((frame) => [frame.event, frame.id])).toEqual([
      ["log", 2],
      ["status", 3],
      ["end", undefined],
    ]);
    expect(jobEventBus.metrics.reconnects).toBe(before.reconnects + 1);
    expect(jobEventBus.metrics.backfilledEvents).toBe(before.backfilledEvents + 1);
  });

  it("falls back to a snapshot when the cursor is unknown to the bus", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id, status: "canceled" }));
    const before = jobEventBus.metrics.snapshotFallbacks;
    const res = await app.inject({
      method: "GET",
      url: `/admin/jobs/${id}/events?cursor=42`,
    });
    const frames = parseSse(res.body);
    expect(frames.map((frame) => frame.event)).toEqual(["snapshot", "end"]);
    expect(jobEventBus.metrics.snapshotFallbacks).toBe(before + 1);
  });

  it("ends a reconnect whose terminal status already left the ring", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id, status: "success" }));
    jobEventBus.publish(id, logEvent(0));
    const res = await app.inject({
      method: "GET",
      url: `/admin/jobs/${id}/events`,
      headers: { "last-event-id": "1" },
    });
    const frames = parseSse(res.body);
    expect(frames.map((frame) => frame.event)).toEqual(["end"]);
  });

  it("releases the stream count after the response ends", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id, status: "success" }));
    const before = jobEventBus.metrics.activeStreams;
    await app.inject({ method: "GET", url: `/admin/jobs/${id}/events` });
    expect(jobEventBus.metrics.activeStreams).toBe(before);
  });
});

describe("GET /admin/jobs/stream-metrics", () => {
  it("exposes the bus counters", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/jobs/stream-metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      activeStreams: expect.any(Number),
      reconnects: expect.any(Number),
      handlerDurations: { count: expect.any(Number) },
    });
  });
});
