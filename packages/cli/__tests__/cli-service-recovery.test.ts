import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as c from "@openmapx/core/build-artifacts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { failedServiceLifecycle } from "../../core/src/build-artifacts/test-fixtures/service-lifecycle-recovery";
import { recoverServiceUpdate } from "../src/lib/service-recovery";

let root: string;
const installations: c.ControlInstallation[] = [];
vi.setConfig({ testTimeout: 30000 });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-cli-recovery-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "infra/docker/data"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "services/alpha"), { recursive: true });
  writeFileSync(
    join(root, "services/alpha/service.json"),
    JSON.stringify({
      id: "alpha",
      name: "Alpha",
      version: "1.0.0",
      quality: "built-in",
      container: { image: "fixture/alpha", tag: "1" },
    }),
  );
  await c.provisionControlInstallation(join(root, "infra/docker"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const installation of installations.splice(0)) c.closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});
it("restores only the caller-named original signed update and leaves its failed receipt unchanged", async () => {
  const fixture = await failedServiceLifecycle(join(root, "infra/docker"));
  installations.push(...fixture.installations);
  vi.spyOn(Date, "now").mockReturnValue(fixture.execution.deadlineAt + 1);
  vi.stubGlobal("fetch", fixture.recoveryFetch);
  vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "d".repeat(32));
  vi.stubEnv("DATA_MANAGER_URL", "http://127.0.0.1:4301");
  const result = await recoverServiceUpdate({
    rootDir: root,
    operationKey: fixture.execution.operationKey,
  });
  expect(result).toEqual({
    operationKey: fixture.execution.operationKey,
    revisionId: fixture.revisionId,
  });
  expect(readFileSync(fixture.path)).toEqual(fixture.receiptBytes);
  expect(existsSync(join(root, "infra/docker/data/.admin-target-control/locks/alpha"))).toBe(false);
});
it("rejects paths instead of looking up a different private record", async () => {
  await expect(
    recoverServiceUpdate({ rootDir: root, operationKey: "../../unrelated" }),
  ).rejects.toThrow("Unsupported control root key");
});
