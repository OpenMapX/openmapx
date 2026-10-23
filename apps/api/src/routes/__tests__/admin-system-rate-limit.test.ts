import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "../../test/auth.js";

// Real route + real rate limiters; only auth, audit, the operations agent and job storage are
// stubbed so the update check -> apply admission sequence is exercised end to end.
const session = mockAdminSession();
const enqueue = vi.fn();
const findActive = vi.fn();
const inspection = {
  dockerReachable: true,
  composeReady: true,
  maintenanceReady: true,
  release: { availableReleaseId: "release-123", availableDigest: "a".repeat(64) },
  services: [],
};

vi.mock("../../utils/require-admin", () => ({
  requireAdmin: async () => session,
  getAdminSession: () => session,
}));
vi.mock("../../utils/audit-log", () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../services/ops-client", () => ({
  createApiOpsClient: () => ({}),
  createDurableOpsKey: () => `opk1_${"a".repeat(43)}`,
  executeAndWait: async () => inspection,
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: {
    enqueue: (...args: unknown[]) => enqueue(...args),
    findActive: (...args: unknown[]) => findActive(...args),
  },
}));

const apply = {
  confirmation: "UPDATE OPENMAPX",
  createBackup: true,
  releaseId: "release-123",
  expectedDigest: "a".repeat(64),
};

let app: FastifyInstance;
let limits: typeof import("../../utils/rate-limit");

beforeAll(async () => {
  limits = await import("../../utils/rate-limit");
  const { adminSystemRoute } = await import("../admin-system");
  app = Fastify({ logger: false });
  await app.register(adminSystemRoute);
  await app.ready();
});

beforeEach(() => {
  // Only Date is faked so Fastify's own scheduling keeps working.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T08:00:00.000Z"));
  enqueue.mockReset().mockResolvedValueOnce("job-check").mockResolvedValue("job-apply");
  findActive.mockReset().mockResolvedValue(null);
  for (const limiter of Object.values(limits)) {
    if (limiter instanceof limits.RateLimiter) limiter.reset();
  }
});

afterEach(() => vi.useRealTimers());
afterAll(() => app?.close());

const check = () => app.inject({ method: "POST", url: "/admin/system/updates/check" });
const applyUpdate = () =>
  app.inject({ method: "POST", url: "/admin/system/updates/apply", payload: apply });

describe("admin update admission", () => {
  it("lets a completed check be applied immediately, one request per action", async () => {
    const checked = await check();
    expect(checked.statusCode).toBe(200);
    expect(checked.json().jobId).toBe("job-check");

    const applied = await applyUpdate();
    expect(applied.statusCode).toBe(200);
    expect(applied.json().jobId).toBe("job-apply");
    expect(enqueue.mock.calls.map((call) => (call[1] as { operation: string }).operation)).toEqual([
      "check",
      "apply",
    ]);
  });

  it("still throttles repeated checks and repeated applies with Retry-After", async () => {
    await check();
    await applyUpdate();
    enqueue.mockClear();

    for (const request of [check, applyUpdate]) {
      const rejected = await request();
      expect(rejected.statusCode).toBe(429);
      expect(rejected.headers["retry-after"]).toBe("30");
      expect(rejected.json()).toEqual({ error: "Too many requests", retryAfter: 30 });
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("admits each action again once its 30 second window refills", async () => {
    await check();
    await applyUpdate();
    vi.setSystemTime(new Date("2026-10-23T08:00:30.000Z"));
    enqueue.mockClear();

    expect((await check()).statusCode).toBe(200);
    expect((await applyUpdate()).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("keeps the active-job guard authoritative once admission permits", async () => {
    findActive.mockResolvedValue({ id: "check-running", status: "running" });
    await check();
    const applied = await applyUpdate();
    expect(applied.statusCode).toBe(409);
    expect(applied.json().jobId).toBe("check-running");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps apply and diagnostics on the shared maintenance bucket, apart from checks", async () => {
    expect((await check()).statusCode).toBe(200);
    const diagnostics = await app.inject({ method: "POST", url: "/admin/system/diagnostics" });
    expect(diagnostics.statusCode).toBe(200);
    // Apply and diagnostics still share the maintenance bucket.
    const applied = await applyUpdate();
    expect(applied.statusCode).toBe(429);
  });
});
