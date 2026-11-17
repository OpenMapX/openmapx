import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { publicAdminJobPayload } from "../admin-job-failure";
import type { JobContext } from "../job-runner";

const effect = vi.hoisted(() => vi.fn(async () => ({ cleared: true, releaseId: "checked" })));
vi.mock("../admin-job-ops", () => ({ executeAdminJobOperation: effect }));
vi.mock("../administrative-configuration-writer", () => ({
  withAdministrativeConfigurationJob: (_ctx: unknown, run: () => unknown) => run(),
  withAdministrativeConfigurationWriter: (_ctx: unknown, run: () => unknown) => run(),
}));
const { handleReleaseClearJob } = await import("../admin-release-controls");
const body = { expectedReleaseId: "checked", confirmation: "CLEAR RELEASE PIN" };
beforeEach(() => {
  effect.mockClear();
});
function context(
  request: unknown = {
    actorId: "admin-a",
    key: "retained-maintenance-source-key-001",
    digest: "b".repeat(64),
  },
) {
  return {
    jobId: randomUUID(),
    jobType: "release.clear",
    payload: { ...body, _maintenanceRequest: request },
    signal: new AbortController().signal,
  } as unknown as JobContext;
}
it("runs a queued maintenance request through its typed operation", async () => {
  await handleReleaseClearJob(context());
  expect(effect).toHaveBeenCalledTimes(1);
});
it.each([
  ["no request record", null],
  ["a malformed key", { actorId: "admin-a", key: "short", digest: "b".repeat(64) }],
  [
    "a malformed digest",
    { actorId: "admin-a", key: "retained-maintenance-source-key-001", digest: "x" },
  ],
])("refuses a job with %s before any operation", async (_name, request) => {
  await expect(handleReleaseClearJob(context(request))).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
});
it("omits the maintenance request record from public Activity payloads", () => {
  expect(publicAdminJobPayload("release.clear", context().payload)).toEqual(body);
});
