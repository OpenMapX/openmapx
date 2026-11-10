import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "../../ops";
import {
  commitConfigurationGeneration,
  withConfigurationGenerationWriter,
} from "../../services/configuration-generation";
import { createDataManagerTransport } from "../../services/data-manager/transport";
import {
  openServiceLifecycleReceipt,
  withServiceLifecycleReceiptAuthority,
  withVerifiedLifecycleOwnership,
} from "../../services/service-lifecycle-receipt";
import { bindControlChildPhase, issueControlChildPhase } from "../child-phase";
import * as c from "../control-authority";
import { createDataConfigurationFenceStore } from "../data-configuration-fence";
import {
  generationHardlinksReservation,
  retainGenerationHardlinksOwnerPlan,
} from "../generation-hardlinks-owner";
import { inspectDataExecutionAdmission } from "../peer-admission";
import * as leases from "../target-lease";

export async function failedServiceLifecycle(
  root: string,
  adopt: boolean | "after-failure" = false,
  issueChild = true,
) {
  const installations: c.ControlInstallation[] = [];
  const generation = {
    infraDir: root,
    services: [],
    input: {
      domain: "example.test",
      selectedRoots: [],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
  };
  const seed = await commitConfigurationGeneration(generation);
  const installation = c.openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["alpha"],
  });
  installations.push(installation);
  const operation = {
    kind: "service.update" as const,
    serviceId: "alpha",
    expectedConfigurationRevisionId: seed.revisionId,
  };
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + 60000,
    operationFingerprint = opsOperationFingerprint(operation);
  const execution = {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    deadlineAt,
    operationFingerprint,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const revisionId = `cfg1_${"b".repeat(43)}`;
  const plan = {
    prune: true as const,
    plan: [
      {
        source: "data/osm",
        target: "data/alpha/osm",
        consumerService: "alpha",
        dataType: "osm-pbf",
      },
    ],
  };
  const reservation = generationHardlinksReservation({
    parent: execution,
    revisionId,
    coordinatorMode: "ensure-running",
    plan,
    serviceIds: ["alpha"],
  })!;
  const authority = c.retainAdmittedControlExecution(installation, {
    execution,
    operation,
    kind: operation.kind,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["alpha"],
    reservations: [reservation],
  });
  const lease = await leases.acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["alpha"],
    owner: authority,
  });
  let assertion = "";
  let child: Awaited<ReturnType<typeof bindControlChildPhase>>;
  async function adoptOriginalChild() {
    const dm = c.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["alpha"],
    });
    installations.push(dm);
    const receiver = inspectDataExecutionAdmission(dm, {
      rawHeaders: ["x-openmapx-control-delegation", assertion],
      input: {
        kind: "generation-hardlinks",
        revisionId,
        coordinatorMode: "ensure-running",
        planDigest: c.controlDigest(plan),
      },
      operationKey: child.execution.operationKey,
      operationFingerprint: reservation.operationFingerprint,
      requestedDeadlineAt: child.execution.deadlineAt,
    });
    const borrowed = await receiver!.adopt(child.execution);
    if (borrowed) {
      const childAuthority = c.retainAdmittedControlExecution(dm, {
        execution: child.execution,
        kind: "generation-hardlinks",
        operation: {
          kind: "generation-hardlinks",
          revisionId,
          coordinatorMode: "ensure-running",
          planDigest: c.controlDigest(plan),
        },
        parent: receiver!.parent,
        admittedAt: Date.now(),
        requestedDeadlineAt: child.execution.deadlineAt,
        serviceIds: ["alpha"],
      });
      leases.bindBorrowedControlExecution(borrowed, childAuthority);
      leases.closeArtifactTargetLeaseHandle(borrowed);
    }
  }
  try {
    retainGenerationHardlinksOwnerPlan(authority, {
      version: 1,
      parent: execution,
      revisionId,
      coordinatorMode: "ensure-running",
      plan,
      reservation,
    });
    const store = await withServiceLifecycleReceiptAuthority(authority, () =>
      openServiceLifecycleReceipt({
        dataRoot: join(root, "data"),
        execution,
        serviceIds: ["alpha"],
        action: "update",
        noDeps: false,
        coordinatorMode: "ensure-running",
        expectedRevisionId: seed.revisionId,
        seedRevisionId: null,
      }),
    );
    await withConfigurationGenerationWriter(root, (writer) =>
      withVerifiedLifecycleOwnership({ writer, lease, authority }, async (ownership) => {
        let receipt = await store.read();
        for (const phase of ["pins_validated", "pulled"] as const) {
          receipt = { ...receipt, phase, sequence: receipt.sequence + 1 };
          await store.checkpoint(receipt.sequence - 1, receipt, ownership);
        }
        await writer.commit({
          ...generation,
          revisionId,
          expectedCurrentRevisionId: seed.revisionId,
        });
        receipt = {
          ...receipt,
          phase: "generation_committed",
          commit: "final_committed",
          finalRevisionId: revisionId,
          sequence: receipt.sequence + 1,
        };
        await store.checkpoint(receipt.sequence - 1, receipt, ownership);
        if (issueChild) {
          child = await bindControlChildPhase(authority, { phase: "hardlinks", ordinal: 0 });
          const issued = await issueControlChildPhase(authority, {
            phase: "hardlinks",
            ordinal: 0,
            childPublicKey: c.controlRolePublicKey(installation, "data-manager"),
            lease,
          });
          assertion = issued.assertion;
          if (adopt === true) await adoptOriginalChild();
        }
        await store.checkpoint(
          receipt.sequence,
          {
            ...receipt,
            phase: "failed",
            followUp: "unknown",
            failure: { reason: "hardlinks", failedServiceIds: ["alpha"] },
            sequence: receipt.sequence + 1,
          },
          ownership,
        );
        if (adopt === "after-failure") await adoptOriginalChild();
      }),
    );
  } finally {
    leases.closeArtifactTargetLeaseHandle(lease);
  }
  const recoveryDm = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["alpha"],
  });
  installations.push(recoveryDm);
  const unsafe = async (query: string) =>
    query.includes("pg_try_advisory_xact_lock") ? [{ held: true }] : [];
  const recoveryFence = createDataConfigurationFenceStore(recoveryDm, {
    unsafe,
    transaction: async (run) => run({ unsafe }),
  });
  const nonAdmission = () =>
    recoveryFence.attestUnadoptedGenerationHardlinks(
      {
        operationKey: child!.execution.operationKey,
        requestedDeadlineAt: child!.execution.deadlineAt,
        input: {
          kind: "generation-hardlinks",
          revisionId,
          coordinatorMode: "ensure-running",
          planDigest: c.controlDigest(plan),
        },
        plan,
      },
      ["x-openmapx-control-delegation", assertion],
    );
  const recoveryRequests: Array<{ url: string; method: string | undefined }> = [];
  const recoveryFetch: typeof fetch = async (url, options) => {
    recoveryRequests.push({ url: String(url), method: options?.method });
    if (
      String(url) !== "http://127.0.0.1:4301/executions/generation-hardlinks/recovery" ||
      options?.method !== "POST"
    )
      throw Error("Unexpected recovery request");
    const headers = new Headers(options?.headers),
      rawHeaders = [...headers.entries()].flat();
    try {
      return Response.json(
        await recoveryFence.attestUnadoptedGenerationHardlinks(
          JSON.parse(String(options?.body)),
          rawHeaders,
        ),
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Recovery unavailable" },
        { status: 409 },
      );
    }
  };
  const transport = createDataManagerTransport({
    baseUrl: "http://127.0.0.1:4301",
    authToken: "d".repeat(32),
    fetch: recoveryFetch,
  });
  const path = join(root, "data/ops-agent/lifecycle", `${execution.operationKey}.json`);
  return {
    installation,
    authority,
    execution,
    path,
    receiptBytes: readFileSync(path),
    revisionId,
    assertion,
    child: child!,
    plan,
    reservation,
    installations,
    leaseId: lease.leaseId,
    transport,
    recoveryFetch,
    recoveryRequests,
    nonAdmission,
  };
}
