import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it("fix1 actual CLI entry refuses an expired retained deadline before its nested Docker runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-cli-deadline-"));
  const marker = join(root, "docker-started");
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(
    join(root, "bin/docker"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`,
    { mode: 0o755 },
  );
  const execution = {
    executor: "ops-agent",
    principal: "api",
    executionId: "job1_0123456789abcdef",
    operationKey: "opk1_0123456789abcdef",
    operationFingerprint: "a".repeat(64),
    fingerprint: "b".repeat(64),
    deadlineAt: Date.now() - 1000,
  };
  try {
    let failure: unknown;
    try {
      await exec(
        resolve("packages/cli/node_modules/.bin/tsx"),
        [
          "--tsconfig",
          resolve("packages/cli/tsconfig.json"),
          resolve("packages/cli/src/index.ts"),
          "services",
          "logs",
          "redis",
        ],
        {
          env: {
            ...process.env,
            OPENMAPX_ROOT_DIR: root,
            OPENMAPX_CONTROL_EXECUTION: JSON.stringify(execution),
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
          },
          timeout: 10000,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(existsSync(marker)).toBe(false);
    expect(String(failure)).toContain("Execution deadline elapsed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("fix1 nested default build runner spends the stored remaining budget across phases and never publishes after expiry", async () => {
  const { buildOsrmGraph } = await import("../src/lib/osrm-graph");
  const { withCliExecutionDeadline } = await import("../src/lib/execution-deadline");
  const { readFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "openmapx-nested-deadline-"));
  const previousPath = process.env.PATH,
    previousExecution = process.env.OPENMAPX_CONTROL_EXECUTION;
  const marker = join(root, "phases");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "services"));
  mkdirSync(join(root, "infra/docker/data/osm"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "infra/docker/data/osm/region.osm.pbf"), "synthetic-pbf");
  mkdirSync(join(root, "infra/docker/data/osrm-graph"));
  writeFileSync(join(root, "infra/docker/data/osrm-graph/region.osrm"), "previous-live");
  writeFileSync(
    join(root, "bin/docker"),
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'phase\\n');const mount=process.argv.find(a=>a.endsWith(':/data')).slice(0,-6);setTimeout(()=>{fs.writeFileSync(mount+'/region.osrm','new');},400);\n`,
    { mode: 0o755 },
  );
  try {
    process.env.PATH = `${join(root, "bin")}:${previousPath}`;
    process.env.OPENMAPX_CONTROL_EXECUTION = JSON.stringify({
      executor: "ops-agent",
      principal: "api",
      executionId: "job1_0123456789abcdef",
      operationKey: "opk1_0123456789abcdef",
      operationFingerprint: "a".repeat(64),
      fingerprint: "b".repeat(64),
      deadlineAt: Date.now() + 650,
    });
    await expect(
      withCliExecutionDeadline(["services", "build", "osrm"], () =>
        buildOsrmGraph({ rootDir: root, image: "synthetic/image:1" }),
      ),
    ).rejects.toThrow();
    expect(readFileSync(marker, "utf8").trim().split("\n").length).toBeLessThanOrEqual(2);
    expect(readFileSync(join(root, "infra/docker/data/osrm-graph/region.osrm"), "utf8")).toBe(
      "previous-live",
    );
  } finally {
    if (previousExecution === undefined) delete process.env.OPENMAPX_CONTROL_EXECUTION;
    else process.env.OPENMAPX_CONTROL_EXECUTION = previousExecution;
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

it("fix1 unsigned metadata can only clamp policy and cannot authorize a remote mutation", async () => {
  const { vi } = await import("vitest");
  const {
    withCliExecutionDeadline,
    cliProcessOptions,
    cliAcquisitionOptions,
    constrainCliDataManagerTransport,
  } = await import("../src/lib/execution-deadline");
  const { opsExecutionBudget } = await import("@openmapx/core/ops");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("OPENMAPX_CLI_DEADLINE_AT", String(Date.now() + 100 * 24 * 3600_000));
  try {
    const request = vi.fn(async () => ({}));
    await withCliExecutionDeadline(["services", "build", "osrm"], async () => {
      const original = cliProcessOptions();
      expect(original.timeout).toBe(opsExecutionBudget("service.build").processMs);
      expect(original.env?.OPENMAPX_CONTROL_EXECUTION).toBeUndefined();
      if (original.timeout === undefined) throw Error("Missing deadline clamp");
      vi.setSystemTime(Date.now() + original.timeout - 5);
      expect(cliProcessOptions().timeout).toBe(5);
      await withCliExecutionDeadline(["services", "update"], async () => {
        expect(cliProcessOptions().timeout).toBe(5);
      });
      const transport = constrainCliDataManagerTransport({ request } as never);
      expect(() => transport.request("link", "/link", { method: "POST" })).toThrow(
        "deadline-aware receiver upgrade",
      );
      expect(request).not.toHaveBeenCalled();
      expect(cliAcquisitionOptions().requestTimeoutMs).toBe(5);
      vi.setSystemTime(Date.now() + 6);
      expect(() => cliProcessOptions()).toThrow("Execution deadline elapsed");
    });
    vi.stubEnv("OPENMAPX_PARENT_EXECUTION", "unsigned-parent");
    await expect(
      withCliExecutionDeadline(["services", "build"], async () => undefined),
    ).rejects.toThrow("CLI control verifier is unavailable");
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
