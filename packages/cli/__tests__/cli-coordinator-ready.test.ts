import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createDataManagerTransport } from "@openmapx/core/data-manager-sdk";
import * as ops from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { expect, it, vi } from "vitest";
import { ownedServiceHost } from "../../../apps/ops-agent/src/__fixtures__/owned-service-host";

const io = vi.hoisted(() => ({ start: vi.fn(async () => 0) }));
vi.mock("../src/lib/docker", () => ({ dockerComposeStream: io.start }));
it("starts an unavailable coordinator without recreation under actual existing ownership", async () => {
  const { ensureCliCoordinatorReady } = await import("../src/lib/coordinator-ready");
  const host = await ownedServiceHost({ withCoordinator: true }),
    installation = control.openControlInstallation({
      infraDir: host.infraDir,
      role: "host-cli",
      serviceIds: ["data-manager", "motis"],
    });
  let lease: control.ArtifactTargetLease | undefined;
  try {
    const operation = {
        kind: "service.start" as const,
        serviceId: "motis",
        expectedConfigurationRevisionId: host.initial.revisionId,
      },
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
      serviceIds: ["data-manager", "motis"],
    });
    lease = await control.acquireArtifactTargetLease({
      dataRoot: join(host.infraDir, "data"),
      owner: authority,
      serviceIds: ["data-manager", "motis"],
    });
    let reads = 0;
    const transport = createDataManagerTransport({
      baseUrl: "http://127.0.0.1:1",
      fetch: async () => {
        reads++;
        return reads === 1
          ? Response.json(
              {
                ok: false,
                status: "starting",
                phase: "job-reconciliation",
                uptime: 0,
                dataDir: "/synthetic",
              },
              { status: 503 },
            )
          : Response.json({
              ok: true,
              status: "ready",
              phase: "complete",
              uptime: 0,
              dataDir: "/synthetic",
            });
      },
    });
    await services.withConfigurationGenerationWriter(host.infraDir, (writer) =>
      services.withVerifiedLifecycleOwnership({ writer, lease: lease!, authority }, (ownership) =>
        ensureCliCoordinatorReady({ ownership, transport, mode: "ensure-running" }),
      ),
    );
    expect(io.start).toHaveBeenCalledExactlyOnceWith(["up", "-d", "--no-recreate", "data-manager"]);
    expect(reads).toBe(2);
    expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
  } finally {
    if (lease) control.closeArtifactTargetLeaseHandle(lease);
    control.closeControlInstallation(installation);
    rmSync(host.cleanupRoot, { recursive: true, force: true });
  }
});
