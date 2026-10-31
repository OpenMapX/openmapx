import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executionRefSchema } from "../ops/execution-ref";
import type { ValidatedBuildBundle } from "./archive";
import * as control from "./control-authority";
import { inspectArtifactPublication, publishValidatedBuild } from "./publication";
import * as leases from "./target-lease";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});
it.each(["old-directory", "build-record"])(
  "restores the original complete set after native death at %s and explicit host writer recovery",
  async (point) => {
    const root = mkdtempSync(join(tmpdir(), "omx-publication-native-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const require = createRequire(
        join(import.meta.dirname, "../../../../apps/ops-agent/package.json"),
      ),
      loader = require.resolve("tsx/esm"),
      child = spawn(
        process.execPath,
        [
          "--import",
          loader,
          join(import.meta.dirname, "test-fixtures/artifact-publication-process.ts"),
          root,
          point,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    const exited = once(child, "exit");
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    await vi.waitFor(
      () => {
        if (child.exitCode !== null || child.signalCode !== null)
          throw Error(`Native fixture exited before fault: ${error}`);
        expect(existsSync(join(root, "fault.json"))).toBe(true);
      },
      { timeout: 30000, interval: 50 },
    );
    const writerPaths = [
      join(root, ".trusted-config-writer"),
      join(root, "state/ops-agent/configuration/.writer"),
    ];
    const writersBefore = writerPaths.map((path) => ({ path, identity: lstatSync(path) }));
    child.kill("SIGKILL");
    const [code, signal] = await exited;
    expect(code).toBeNull();
    expect(signal).toBe("SIGKILL");
    // This isolated fixture owns its ONLY writer and has just killed it. Model
    // the documented explicit host operation; production never steals this lock
    // using elapsed time, a PID, or a missing process as execution authority.
    // The current writer owns its state lock and the unretired legacy lock.
    // Explicit recovery removes only those two exact empty fixture-owned inodes.
    for (const { path, identity: before } of writersBefore.reverse()) {
      const after = lstatSync(path);
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(after.isDirectory() && !after.isSymbolicLink()).toBe(true);
      rmdirSync(path); // Empty, exact owned lock only; no recursive deletion.
    }

    const state = JSON.parse(readFileSync(join(root, "fault.json"), "utf8")) as {
        execution: unknown;
        stageId: string;
        stagingRoot: string;
        bundle: ValidatedBuildBundle;
        expectedFingerprint: string;
        oldRecord: string;
        oldDirectoryInode: number;
        leaseId: string;
        admissionDigest: string;
      },
      installation = control.openControlInstallation({
        infraDir: root,
        role: "host-cli",
        serviceIds: ["osrm"],
      });
    cleanup.push(() => control.closeControlInstallation(installation));
    const authority = control.restoreAdmittedControlExecution(
      installation,
      executionRefSchema.parse(state.execution),
    );
    expect(control.executionAuthorityState(authority).receiptDigest).toBe(state.admissionDigest);
    control.cancelControlExecution(authority);
    const lease = leases.restoreArtifactTargetLeaseForSettlement(authority);
    cleanup.push(() => leases.closeArtifactTargetLeaseHandle(lease));
    expect(lease.leaseId).toBe(state.leaseId);
    expect(inspectArtifactPublication(authority)?.phase).toBe("prepared");
    const input = {
      dataRoot: join(root, "data"),
      stagingRoot: state.stagingRoot,
      stageId: state.stageId,
      bundle: state.bundle,
      authority,
      lease,
      expectedFingerprint: state.expectedFingerprint,
    };
    expect(await publishValidatedBuild(input)).toMatchObject({
      outcome: "not_committed",
      reason: "failed",
    });
    expect(statSync(join(root, "data/osrm-graph")).ino).toBe(state.oldDirectoryInode);
    expect(readFileSync(join(root, "data/osrm-graph/old"), "utf8")).toBe("old graph");
    expect(readFileSync(join(root, "data/.openmapx-builds/osrm.json"), "utf8")).toBe(
      state.oldRecord,
    );
    expect(existsSync(join(root, "data/osrm-graph/region.osrm"))).toBe(false);
    expect(await publishValidatedBuild(input)).toMatchObject({
      outcome: "not_committed",
      reason: "failed",
    });
    expect(() => leases.verifyRetainedArtifactTargetRootRelease(authority)).toThrow();
    control.retainControlEffectReceipt(authority, {
      outcome: "contained",
      publication: "not_started",
      receipt: {
        kind: "ops-result",
        result: { outcome: "not_committed", reason: "failed", cleanupFailed: false },
      },
    });
    await leases.settleArtifactTargetLeaseChild(
      lease,
      control.verifyControlEffectSettlement(installation, authority.execution),
    );
    await leases.releaseArtifactTargetLease(lease);
    expect(leases.verifyRetainedArtifactTargetRootRelease(authority).releasedAt).toBeGreaterThan(0);
  },
  60000,
);
