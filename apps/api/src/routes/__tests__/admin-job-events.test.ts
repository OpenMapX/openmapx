import Fastify, { type FastifyInstance } from "fastify";
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
  vi.unstubAllGlobals();
  await app?.close();
});

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Network denied");
  });
  mockGetActivityJob.mockReset();
});

describe("GET /admin/jobs/:id/events", () => {
  it.each(["snapshot", "live", "replay"])(
    "observes cancel_pending via %s until terminal completion",
    async (mode) => {
      const id = nextJobId();
      const pending = { type: "status" as const, status: "cancel_pending" };
      mockGetActivityJob.mockResolvedValue(
        jobRow({ id, status: mode === "live" ? "running" : "cancel_pending", cancelable: false }),
      );
      if (mode === "replay") {
        jobEventBus.publish(id, logEvent(0));
        jobEventBus.publish(id, pending);
      }
      const timer = setTimeout(() => {
        if (mode === "live") jobEventBus.publish(id, pending);
        jobEventBus.publish(id, { type: "status", status: "canceled" });
      }, 20);
      const before = jobEventBus.metrics.activeStreams;
      try {
        const response = await app.inject({
          url: `/admin/jobs/${id}/events`,
          ...(mode === "replay" ? { headers: { "last-event-id": "1" } } : {}),
        });
        expect(response.statusCode).toBe(200);
        const frames = parseSse(response.body);
        expect(frames.map((frame) => frame.event)).toEqual(
          mode === "snapshot"
            ? ["snapshot", "status", "end"]
            : mode === "live"
              ? ["snapshot", "status", "status", "end"]
              : ["status", "status", "end"],
        );
        expect(frames[mode === "live" ? 1 : 0]?.data).toMatchObject(
          mode === "snapshot" ? { job: { status: "cancel_pending", cancelable: false } } : pending,
        );
        expect(frames.at(-1)?.data).toEqual({ status: "canceled" });
        expect(jobEventBus.metrics.activeStreams).toBe(before);
      } finally {
        clearTimeout(timer);
      }
    },
  );

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

  it("rejects malformed cursor/query/header after auth and before job acquisition", async () => {
    for (const query of [
      "cursor=1x",
      "cursor=-1",
      "cursor=1.5",
      "cursor=",
      "cursor=1&cursor=2",
      "source=invalid",
    ]) {
      const response = await app.inject(`/admin/jobs/x/events?${query}`);
      expect(response.statusCode, query).toBe(400);
    }
    expect(
      (await app.inject({ url: "/admin/jobs/x/events", headers: { "last-event-id": "2suffix" } }))
        .statusCode,
    ).toBe(400);
    mockRequireAdmin.mockRejectedValueOnce(Object.assign(new Error("Denied"), { statusCode: 403 }));
    expect((await app.inject("/admin/jobs/x/events?cursor=secret")).statusCode).toBe(403);
    expect(mockGetActivityJob).not.toHaveBeenCalled();
  });

  it("rejects malformed initial producer data before hijacking", async () => {
    mockGetActivityJob.mockResolvedValue(
      jobRow({ payload: { secret: "redact" }, status: "unknown" }),
    );
    const response = await app.inject("/admin/jobs/invalid/events");
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("redact");
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it.each(["throw", "invalid"])(
    "closes and unsubscribes when the snapshot re-read is %s",
    async (mode) => {
      const id = nextJobId();
      mockGetActivityJob.mockResolvedValueOnce(jobRow({ id }));
      if (mode === "throw") mockGetActivityJob.mockRejectedValueOnce(new Error("secret snapshot"));
      else mockGetActivityJob.mockResolvedValueOnce(jobRow({ id, progress: "secret snapshot" }));
      const before = jobEventBus.metrics.activeStreams;
      const unsubscribe = vi.fn();
      const realSubscribe = jobEventBus.subscribe.bind(jobEventBus);
      const spy = vi.spyOn(jobEventBus, "subscribe").mockImplementation((jobId, listener) => {
        const cleanup = realSubscribe(jobId, listener);
        return () => {
          unsubscribe();
          cleanup();
        };
      });
      try {
        const response = await app.inject(`/admin/jobs/${id}/events`);
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain("secret snapshot");
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(jobEventBus.metrics.activeStreams).toBe(before);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("closes safely on malformed live events without writing producer content", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id }));
    setTimeout(() => {
      jobEventBus.publish(id, { type: "progress", progress: Number.NaN });
    }, 10);
    const before = jobEventBus.metrics.activeStreams;
    const response = await app.inject(`/admin/jobs/${id}/events`);
    expect(parseSse(response.body).map((frame) => frame.event)).toEqual(["snapshot"]);
    expect(jobEventBus.metrics.activeStreams).toBe(before);
  });

  it("bounds priming backlog while snapshot acquisition is pending", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValueOnce(jobRow({ id }));
    mockGetActivityJob.mockImplementationOnce(async () => {
      for (let i = 0; i < 201; i++) jobEventBus.publish(id, logEvent(i));
      return jobRow({ id });
    });
    const before = jobEventBus.metrics.activeStreams;
    const response = await app.inject(`/admin/jobs/${id}/events`);
    expect(parseSse(response.body)).toEqual([
      { event: "overflow", data: { reason: "slow consumer" } },
    ]);
    expect(jobEventBus.metrics.activeStreams).toBe(before);
  });

  it("disconnects a slow output writer with a qualified overflow event", async () => {
    const slowApp = Fastify();
    slowApp.addHook("onRequest", async (_request, reply) => {
      const write = reply.raw.write.bind(reply.raw);
      reply.raw.write = ((chunk: string) => {
        write(chunk);
        return false;
      }) as typeof reply.raw.write;
    });
    await slowApp.register(adminJobEventsRoute);
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id }));
    setTimeout(() => {
      for (let i = 0; i < 205; i++) jobEventBus.publish(id, logEvent(i));
    }, 10);
    const before = jobEventBus.metrics.activeStreams;
    try {
      const response = await slowApp.inject(`/admin/jobs/${id}/events`);
      expect(parseSse(response.body).at(-1)).toEqual({
        event: "overflow",
        data: { reason: "slow consumer" },
      });
      expect(jobEventBus.metrics.activeStreams).toBe(before);
    } finally {
      await slowApp.close();
    }
  });

  it("uses the numeric query cursor and gives Last-Event-ID precedence", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id, status: "success" }));
    jobEventBus.publish(id, logEvent(0));
    jobEventBus.publish(id, logEvent(1));
    jobEventBus.publish(id, logEvent(2));
    const query = await app.inject(`/admin/jobs/${id}/events?cursor=2`);
    expect(parseSse(query.body).map((frame) => [frame.event, frame.id])).toEqual([
      ["log", 3],
      ["end", undefined],
    ]);
    const header = await app.inject({
      url: `/admin/jobs/${id}/events?cursor=2`,
      headers: { "last-event-id": "1", origin: "https://app.test" },
    });
    expect(parseSse(header.body).map((frame) => [frame.event, frame.id])).toEqual([
      ["log", 2],
      ["log", 3],
      ["end", undefined],
    ]);
  });

  it("keeps unrelated normalized HTTP headers available to outer hooks", async () => {
    const headerApp = Fastify();
    const observed: unknown[] = [];
    headerApp.addHook("onResponse", async (request) => {
      observed.push({ origin: request.headers.origin, cookie: request.headers.cookie });
    });
    await headerApp.register(adminJobEventsRoute);
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(
      jobRow({ id, status: "success", createdAt: new Date("2026-09-06T08:00:00Z") }),
    );
    try {
      const response = await headerApp.inject({
        url: `/admin/jobs/${id}/events`,
        headers: { origin: "https://app.test", cookie: "session=fake", "last-event-id": "0" },
      });
      expect(parseSse(response.body)[0]?.data).toMatchObject({
        job: { createdAt: "2026-09-06T08:00:00.000Z" },
      });
      expect(observed).toEqual([{ origin: "https://app.test", cookie: "session=fake" }]);
    } finally {
      await headerApp.close();
    }
  });

  it("closes malformed replay data without leaking it", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id }));
    jobEventBus.publish(id, logEvent(0));
    jobEventBus.publish(id, { ...logEvent(1), seq: -1, line: "private malformed log" });
    const before = jobEventBus.metrics.activeStreams;
    const response = await app.inject(`/admin/jobs/${id}/events?cursor=1`);
    expect(parseSse(response.body)).toEqual([]);
    expect(response.body).not.toContain("private malformed log");
    expect(jobEventBus.metrics.activeStreams).toBe(before);
  });

  it("does not subscribe or start a stream after disconnect during the initial lookup", async () => {
    const earlyApp = Fastify();
    let disconnect = () => {};
    earlyApp.addHook("onRequest", async (_request, reply) => {
      disconnect = () => {
        reply.raw.emit("close");
      };
    });
    await earlyApp.register(adminJobEventsRoute);
    const id = nextJobId();
    mockGetActivityJob.mockImplementation(async () => {
      disconnect();
      return jobRow({ id, status: "success" });
    });
    const subscribe = vi.spyOn(jobEventBus, "subscribe");
    try {
      await expect(earlyApp.inject(`/admin/jobs/${id}/events`)).rejects.toThrow(
        "response destroyed before completion",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      subscribe.mockRestore();
      await earlyApp.close();
    }
  });

  it("unsubscribes on disconnect during snapshot acquisition without starting a heartbeat", async () => {
    const disconnectApp = Fastify();
    let disconnect = () => {};
    disconnectApp.addHook("onRequest", async (request) => {
      disconnect = () => {
        request.raw.emit("close");
      };
    });
    await disconnectApp.register(adminJobEventsRoute);
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValueOnce(jobRow({ id }));
    mockGetActivityJob.mockImplementationOnce(async () => {
      disconnect();
      return jobRow({ id });
    });
    const realSubscribe = jobEventBus.subscribe.bind(jobEventBus);
    const unsubscribe = vi.fn();
    const spy = vi.spyOn(jobEventBus, "subscribe").mockImplementation((jobId, listener) => {
      const cleanup = realSubscribe(jobId, listener);
      return () => {
        unsubscribe();
        cleanup();
      };
    });
    const timer = vi.spyOn(globalThis, "setInterval");
    const before = jobEventBus.metrics.activeStreams;
    try {
      const response = await disconnectApp.inject(`/admin/jobs/${id}/events`);
      expect(parseSse(response.body)).toEqual([]);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(timer).not.toHaveBeenCalled();
      expect(jobEventBus.metrics.activeStreams).toBe(before);
    } finally {
      spy.mockRestore();
      timer.mockRestore();
      await disconnectApp.close();
    }
  });

  it("clears the active heartbeat when terminal delivery closes the connection", async () => {
    const id = nextJobId();
    mockGetActivityJob.mockResolvedValue(jobRow({ id }));
    const clear = vi.spyOn(globalThis, "clearInterval");
    const start = vi.spyOn(globalThis, "setInterval");
    setTimeout(() => {
      jobEventBus.publish(id, { type: "status", status: "success" });
    }, 10);
    try {
      await app.inject(`/admin/jobs/${id}/events`);
      const heartbeat = start.mock.results.find((result) => result.type === "return")?.value;
      expect(heartbeat).toBeDefined();
      expect(clear).toHaveBeenCalledWith(heartbeat);
    } finally {
      start.mockRestore();
      clear.mockRestore();
    }
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

  it.each(["live", "replay"])("records publication-to-write lag for %s delivery", async (mode) => {
    const id = nextJobId();
    let now = 10;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const previous = jobEventBus.metrics.maxPublishLagMs;
    jobEventBus.metrics.maxPublishLagMs = 0;
    try {
      if (mode === "replay") {
        jobEventBus.publish(id, logEvent(0));
        jobEventBus.publish(id, logEvent(1));
        now = 90;
        mockGetActivityJob.mockResolvedValue(jobRow({ id, status: "success" }));
      } else {
        mockGetActivityJob.mockResolvedValueOnce(jobRow({ id }));
        mockGetActivityJob.mockImplementationOnce(async () => {
          jobEventBus.publish(id, logEvent(0));
          jobEventBus.publish(id, { type: "status", status: "success" });
          now = 90;
          return jobRow({ id });
        });
      }
      const res = await app.inject({
        method: "GET",
        url: `/admin/jobs/${id}/events`,
        ...(mode === "replay" ? { headers: { "last-event-id": "1" } } : {}),
      });
      expect(parseSse(res.body).map((frame) => frame.event)).toEqual(
        mode === "replay" ? ["log", "end"] : ["snapshot", "log", "status", "end"],
      );
      expect(jobEventBus.metrics.maxPublishLagMs).toBe(80);
    } finally {
      clock.mockRestore();
      jobEventBus.metrics.maxPublishLagMs = previous;
    }
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
