import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dockerCompose } from "../src/lib/docker";
import { leasedHostEffect, withHostTargets } from "../src/lib/host-effect";

vi.mock("../src/lib/docker", async (original) => ({
  ...(await original<typeof import("../src/lib/docker")>()),
  dockerCompose: vi.fn(),
}));

let root: string;
let infraDir: string;
let errors: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-host-effect-"));
  infraDir = join(root, "infra/docker");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(infraDir, { recursive: true });
  vi.stubEnv("OPENMAPX_ROOT_DIR", root);
  errors = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    errors.push(String(line));
  });
  // The agent's container is not running, so the CLI writes the store itself.
  vi.mocked(dockerCompose)
    .mockReset()
    .mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as Awaited<ReturnType<typeof dockerCompose>>);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const held = () => control.heldTargets(infraDir);

describe("host effects under a lease", () => {
  it("holds the targets while the effect runs and releases them after", async () => {
    let during: string[] = [];
    const code = await leasedHostEffect(
      "services.restart",
      ["community-live", "alpha"],
      async () => {
        during = held();
        return 0;
      },
    );
    expect(code).toBe(0);
    expect(during).toEqual(["alpha", "community-live"]);
    expect(held()).toEqual([]);
  });

  it("refuses a held target before the effect and names the holder", async () => {
    const holder = {
      executor: "ops-agent" as const,
      principal: "api" as const,
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
      operationFingerprint: "a".repeat(64),
      fingerprint: "b".repeat(64),
      deadlineAt: Date.now() + 60_000,
    };
    await control
      .localLeaseBackend(
        control.openLeaseStore({
          directory: control.leaseStoreDirectory(infraDir),
          purpose: "test",
        }),
      )
      .acquire({ owner: holder, ownerKind: "service.update", targets: ["alpha"] });
    const effect = vi.fn(async () => 0);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const pending = leasedHostEffect("services.stop", ["alpha"], effect);
      await vi.advanceTimersByTimeAsync(6000);
      expect(await pending).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    expect(effect).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain(holder.operationKey);
    expect(held()).toEqual(["alpha"]);
  });

  it("releases the targets of an effect that failed and passes the failure on", async () => {
    await expect(
      withHostTargets({ kind: "backup.restore", targets: ["postgis"] }, async () => {
        throw Error("restore failed");
      }),
    ).rejects.toThrow("restore failed");
    expect(held()).toEqual([]);
  });
});
