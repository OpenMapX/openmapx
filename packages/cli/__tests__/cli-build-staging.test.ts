import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareStagedBuildDir,
  promoteStagedBuildDir,
  promoteStagedBuildDirs,
} from "../src/lib/build-staging";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-build-staging-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dirWith(path: string, content: string): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "file"), content);
  return path;
}

describe("staged build dirs", () => {
  it("clears leftover .prev and .next before a build starts", () => {
    const live = dirWith(join(tmp, "graph"), "LIVE");
    dirWith(`${live}.prev`, "STALE");
    dirWith(`${live}.next`, "STALE");

    const next = prepareStagedBuildDir(live);

    expect(existsSync(`${live}.prev`)).toBe(false);
    expect(existsSync(join(next, "file"))).toBe(false);
    expect(readFileSync(join(live, "file"), "utf-8")).toBe("LIVE");
  });

  it("swaps several dirs as one unit", () => {
    const a = dirWith(join(tmp, "a"), "OLD-A");
    const b = dirWith(join(tmp, "b"), "OLD-B");
    const swaps = [
      { liveDir: a, nextDir: dirWith(join(tmp, "a.next"), "NEW-A") },
      { liveDir: b, nextDir: dirWith(join(tmp, "b.next"), "NEW-B") },
    ];

    promoteStagedBuildDirs(swaps);

    expect(readFileSync(join(a, "file"), "utf-8")).toBe("NEW-A");
    expect(readFileSync(join(b, "file"), "utf-8")).toBe("NEW-B");
    expect(existsSync(`${a}.prev`)).toBe(false);
    expect(existsSync(`${b}.prev`)).toBe(false);
  });

  it("restores every live dir when a later swap fails", () => {
    const a = dirWith(join(tmp, "a"), "OLD-A");
    const b = dirWith(join(tmp, "b"), "OLD-B");
    const aNext = dirWith(join(tmp, "a.next"), "NEW-A");

    expect(() =>
      promoteStagedBuildDirs([
        { liveDir: a, nextDir: aNext },
        { liveDir: b, nextDir: join(tmp, "missing.next") },
      ]),
    ).toThrow();

    expect(readFileSync(join(a, "file"), "utf-8")).toBe("OLD-A");
    expect(readFileSync(join(b, "file"), "utf-8")).toBe("OLD-B");
    expect(readFileSync(join(aNext, "file"), "utf-8")).toBe("NEW-A");
  });
});
it("keeps staged and live bytes unchanged when the retained parent cancels before publication", async () => {
  const { randomBytes, randomUUID } = await import("node:crypto"),
    control = await import("@openmapx/core/build-artifacts"),
    ops = await import("@openmapx/core/ops"),
    { withHostDataControlContext } = await import("../src/lib/control-context");
  const ownerRoot = mkdtempSync(join(tmpdir(), "omx-canceled-build-"));
  mkdirSync(join(ownerRoot, "data"), { mode: 0o700 });
  await control.provisionControlInstallation(ownerRoot);
  const installation = control.openControlInstallation({
    infraDir: ownerRoot,
    role: "host-cli",
    serviceIds: ["osrm"],
  });
  try {
    const operation = { kind: "service.build" as const, serviceId: "osrm" },
      admittedAt = Date.now(),
      deadlineAt = admittedAt + 60000,
      operationFingerprint = ops.opsOperationFingerprint(operation),
      execution = {
        executor: "host-cli" as const,
        principal: "host-cli" as const,
        executionId: randomUUID(),
        operationKey: ops.createControlRootOperationKey({
          notAfter: deadlineAt,
          nonce: randomBytes(16),
        }),
        operationFingerprint,
        deadlineAt,
        fingerprint: ops.executionFingerprint({
          kind: operation.kind,
          operationFingerprint,
          deadlineAt,
        }),
      };
    const authority = control.retainAdmittedControlExecution(installation, {
      execution,
      operation,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["osrm"],
    });
    const liveDir = join(ownerRoot, "data/graph");
    mkdirSync(liveDir);
    writeFileSync(join(liveDir, "old"), "old");
    const nextDir = prepareStagedBuildDir(liveDir);
    writeFileSync(join(nextDir, "new"), "new");
    control.cancelControlExecution(authority);
    await withHostDataControlContext(installation, authority, async () => {
      expect(() => promoteStagedBuildDir(liveDir, nextDir)).toThrow();
      expect(() => prepareStagedBuildDir(liveDir)).toThrow();
    });
    expect(readFileSync(join(liveDir, "old"), "utf8")).toBe("old");
    expect(readFileSync(join(nextDir, "new"), "utf8")).toBe("new");
  } finally {
    control.closeControlInstallation(installation);
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});
