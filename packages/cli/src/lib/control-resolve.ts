import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeaseRecord } from "@openmapx/core/build-artifacts";
import {
  createDataManagerTransport,
  DataManagerHttpError,
  settleDataConfigurationFence,
} from "@openmapx/core/data-manager-sdk";
import { z } from "zod";
import { dataManagerUrl } from "./data-manager-url";

/** One of the agent's own records, as it keeps them in its private state. */
function agentRecord(infraDir: string, namespace: string, name: string): unknown {
  const raw = JSON.parse(
    readFileSync(join(infraDir, "control-private", "ops-agent", namespace, name), "utf8"),
  ) as { payload?: unknown };
  return raw.payload ?? raw;
}

/**
 * Settles the data-manager fence of a maintenance the operator resolves, with
 * the agent's own data-manager token and the original preparation delegation,
 * as the agent itself would. A fence that was never prepared needs nothing.
 */
export async function settleMaintenanceFence(
  infraDir: string,
  lease: LeaseRecord,
  as: "committed" | "failed",
): Promise<void> {
  const fence = lease.children.find((child) => child.phase === "configuration-fence");
  if (!fence) return;
  const admission = z
    .object({ operation: z.object({ maintenanceId: z.uuid() }).passthrough() })
    .passthrough()
    .parse(agentRecord(infraDir, "executions", `${lease.owner.operationKey}.json`));
  const owner = z
    .object({
      plan: z
        .object({
          operation: z.object({ maintenanceId: z.uuid(), candidateId: z.uuid() }).passthrough(),
          planDigest: z.string(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(
      agentRecord(
        infraDir,
        "configuration-maintenance",
        `${admission.operation.maintenanceId}.json`,
      ),
    );
  const attempt = z
    .object({ assertion: z.string() })
    .passthrough()
    .parse(agentRecord(infraDir, "attempts", `${fence.key}.json`));
  const token = readFileSync(
    join(infraDir, "secrets", "data-manager-ops-agent-token"),
    "utf8",
  ).trim();
  try {
    await settleDataConfigurationFence(
      {
        maintenanceId: owner.plan.operation.maintenanceId,
        candidateId: owner.plan.operation.candidateId,
        planDigest: owner.plan.planDigest,
        outcome: as === "committed" ? "applied" : "contained",
      },
      {
        transport: createDataManagerTransport({
          baseUrl: dataManagerUrl(),
          authToken: token,
          requestTimeoutMs: 15000,
          maxJsonBytes: 65536,
        }),
        controlAssertion: attempt.assertion,
      },
    );
  } catch (error) {
    // No fence row: the preparation never reached data-manager.
    if (error instanceof DataManagerHttpError && error.status === 404) return;
    throw error;
  }
}
