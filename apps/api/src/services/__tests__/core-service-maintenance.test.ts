import { afterAll, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  const value = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET ??= "core-restart-unit-test-only-000000000000000000";
  return value;
});
afterAll(() => {
  if (env === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = env;
});
const execute = vi.hoisted(() => vi.fn());
const inspect = vi.hoisted(() => vi.fn());
const original = vi.hoisted(() => vi.fn());
vi.mock("../admin-job-ops", () => ({
  executeAdminJobOperation: execute,
  retainedAdminJobOperation: original,
}));
vi.mock("../ops-client", () => ({
  createApiOpsClient: () => ({}),
  createDurableOpsKey: (scope: string, key: string) => `${scope}:${key}`,
  executeAndWait: inspect,
}));
const { runCoreServiceMaintenance } = await import("../core-service-maintenance");
const revision = `cfg1_${"r".repeat(43)}`;
function context(service: string) {
  const ctx = {
    jobId: "job",
    payload: { service },
    signal: new AbortController().signal,
    log: vi.fn(async () => {}),
    setProgress: vi.fn(async () => {}),
    checkpointResult: {} as Record<string, unknown>,
    checkpoint: vi.fn(async (value: Record<string, unknown>) => {
      ctx.checkpointResult = value;
    }),
  };
  return ctx;
}
it.each(["app-api", "traefik"])(
  "retains the exact %s restart condition before dispatch",
  async (service) => {
    execute.mockReset().mockResolvedValue({ changed: true, serviceId: service });
    inspect.mockReset().mockResolvedValue({ revisionId: revision });
    original.mockReset().mockReturnValue(undefined);
    const ctx = context(service);
    await expect(runCoreServiceMaintenance(ctx)).resolves.toEqual({ service, action: "restart" });
    expect(ctx.checkpoint).toHaveBeenCalledBefore(execute);
    expect(execute).toHaveBeenCalledWith(
      ctx,
      {
        kind: "coreService.restart",
        serviceId: service,
        expectedConfigurationRevisionId: revision,
      },
      "admin-job.service.core-restart",
      { durableIdentity: service },
    );
    original.mockReturnValue({
      kind: "coreService.restart",
      serviceId: service,
      expectedConfigurationRevisionId: revision,
    });
    inspect.mockClear();
    await runCoreServiceMaintenance(ctx);
    expect(inspect).not.toHaveBeenCalled();
  },
);
it.each(["ops-agent", "redis", "postgis", "unknown"])(
  "rejects %s without executing anything",
  async (service) => {
    execute.mockClear();
    inspect.mockClear();
    await expect(runCoreServiceMaintenance(context(service))).rejects.toThrow("not available");
    expect(execute).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  },
);
