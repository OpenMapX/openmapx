import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MaintenanceRequestConflict } from "../../services/retained-maintenance-job";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers";

const { requireAdmin, getAdminSession } = installAdminRouteMocks();
const enqueue = vi.hoisted(() => vi.fn(async () => "job-release-clear"));
vi.mock("../../services/service-registry", () => ({
  getServiceRegistry: () => ({
    get: (id: string) =>
      ["motis", "data-manager", "ops-agent"].includes(id) ? { enabled: true } : undefined,
  }),
}));
vi.mock("../../services/job-runner", () => ({ jobRunner: { enqueueMaintenance: enqueue } }));
let app: FastifyInstance;
const key = { "idempotency-key": "clear-pin-retained-intent-001" },
  body = { expectedReleaseId: "checked-pin", confirmation: "CLEAR RELEASE PIN" };
beforeAll(async () => {
  const { adminReleaseControlsRoute } = await import("../admin-release-controls");
  app = await createAdminTestApp(adminReleaseControlsRoute, { prefix: "/api" });
});
afterAll(() => app?.close());
afterEach(() => {
  vi.clearAllMocks();
});
describe("image-only staging controls", () => {
  it("queues only registered enabled IDs with a caller-owned mutation key", async () => {
    const request = { serviceIds: ["data-manager", "ops-agent", "motis"] };
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/services/images/pull",
      headers: key,
      payload: request,
    });
    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      "service.images.pull",
      request,
      getAdminSession.mock.results.at(-1)?.value.user.id,
      key["idempotency-key"],
    );
  });
  it.each([
    { serviceIds: [] },
    { serviceIds: ["unknown"] },
    { serviceIds: ["motis", "motis"] },
    { serviceIds: ["motis"], image: "caller/image:tag" },
    { serviceIds: Array.from({ length: 65 }, (_, i) => `service-${i}`) },
  ])("refuses invalid staging input %j without a job", async (payload) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/services/images/pull",
      headers: key,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
describe("release selection controls", () => {
  it("queues the exact pin and caller-owned key without a synchronous host effect", async () => {
    const result = await app.inject({
      method: "POST",
      url: "/api/admin/system/release/clear",
      headers: key,
      payload: body,
    });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual({ ok: true, jobId: "job-release-clear" });
    expect(enqueue).toHaveBeenCalledWith(
      "release.clear",
      body,
      getAdminSession.mock.results.at(-1)?.value.user.id,
      key["idempotency-key"],
    );
  });
  it.each([
    { ...body, confirmation: "clear" },
    { ...body, extra: true },
    { ...body, expectedReleaseId: "../escape" },
    {},
  ])("rejects invalid intent %j", async (payload) => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/system/release/clear",
          headers: key,
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("requires the retained key and full administrator guard", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/admin/system/release/clear", payload: body }))
        .statusCode,
    ).toBe(400);
    requireAdmin.mockRejectedValueOnce(
      Object.assign(Error("Authentication required"), { statusCode: 401 }),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/system/release/clear",
          headers: key,
          payload: body,
        })
      ).statusCode,
    ).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("reports actor/key conflict without accepting another mutation", async () => {
    enqueue.mockRejectedValueOnce(new MaintenanceRequestConflict("different request"));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/system/release/clear",
          headers: key,
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
  });
});
