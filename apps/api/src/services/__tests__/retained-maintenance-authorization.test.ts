import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicAdminJobPayload } from "../admin-job-failure";
import type { JobContext } from "../job-runner";
import { maintenanceJobAuthorization } from "../retained-maintenance-authorization";

const effect = vi.hoisted(() => vi.fn(async () => ({ cleared: true, releaseId: "checked" })));
vi.mock("../admin-job-ops", () => ({ executeAdminJobOperation: effect }));
vi.mock("../administrative-configuration-writer", () => ({
  withAdministrativeConfigurationJob: (_ctx: unknown, run: () => unknown) => run(),
  withAdministrativeConfigurationWriter: (_ctx: unknown, run: () => unknown) => run(),
}));
const { handleReleaseClearJob } = await import("../admin-release-controls");
const token = "a".repeat(43),
  body = { expectedReleaseId: "checked", confirmation: "CLEAR RELEASE PIN" },
  actorId = "admin-a",
  key = "retained-maintenance-source-key-001";
let root: string;
beforeEach(() => {
  effect.mockClear();
  root = mkdtempSync(join(tmpdir(), "omx-maintenance-auth-"));
  const file = join(root, "token");
  writeFileSync(file, token, { mode: 0o600 });
  vi.stubEnv("OPS_AGENT_TOKEN_FILE", file);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function context() {
  const jobId = randomUUID(),
    metadata = {
      actorId,
      key,
      digest: "b".repeat(64),
      authorization: maintenanceJobAuthorization(token, {
        jobId,
        type: "release.clear",
        payload: body,
        actorId,
        key,
      }),
    };
  return {
    jobId,
    jobType: "release.clear",
    payload: { ...body, _maintenanceRequest: metadata },
    signal: new AbortController().signal,
  } as unknown as JobContext;
}
it("accepts the exact retained row before dispatching a typed operation", async () => {
  await handleReleaseClearJob(context());
  expect(effect).toHaveBeenCalledTimes(1);
});
it("refuses a copied authorization under a different actual job ID before any operation", async () => {
  const ctx = context();
  ctx.jobId = randomUUID();
  await expect(handleReleaseClearJob(ctx)).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
});
it.each(["actor", "body", "key"])("rejects changed %s bytes before effects", async (field) => {
  const ctx = context(),
    metadata = ctx.payload._maintenanceRequest as Record<string, unknown>;
  if (field === "body") ctx.payload.expectedReleaseId = "changed";
  else if (field === "actor") metadata.actorId = "other";
  else metadata.key = "different-maintenance-source-key-002";
  await expect(handleReleaseClearJob(ctx)).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
});
it("omits private maintenance authorization from public Activity payloads", () => {
  const ctx = context();
  expect(publicAdminJobPayload("release.clear", ctx.payload)).toEqual(body);
});
