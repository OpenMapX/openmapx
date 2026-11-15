import type { LeaseRecord } from "@openmapx/core/build-artifacts";
import {
  createDataManagerTransport,
  DataManagerHttpError,
  settleDataConfigurationFence,
} from "@openmapx/core/data-manager-sdk";
import { z } from "zod";
import { cliDataManagerToken } from "./data-manager-token";
import { dataManagerUrl } from "./data-manager-url";

/** What the agent records on a maintenance's fence child for this settle. */
const fenceEvidenceSchema = z.object({
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  planDigest: z.string(),
});

/**
 * Settles the data-manager fence of a maintenance the operator resolves. The
 * settle inputs come from the fence child in the agent's lease store; the
 * request goes the way the CLI's other data-manager calls go, with the CLI's
 * own token, which data-manager accepts as the operator's resolution. A fence
 * that was never prepared needs nothing.
 */
export async function settleMaintenanceFence(
  lease: LeaseRecord,
  as: "committed" | "failed",
): Promise<void> {
  const fence = lease.children.find((child) => child.phase === "configuration-fence");
  if (!fence) return;
  const evidence = fenceEvidenceSchema.parse(fence.evidence);
  try {
    await settleDataConfigurationFence(
      { ...evidence, outcome: as === "committed" ? "applied" : "contained" },
      {
        transport: createDataManagerTransport({
          baseUrl: dataManagerUrl(),
          authToken: cliDataManagerToken(),
          requestTimeoutMs: 15000,
          maxJsonBytes: 65536,
        }),
      },
    );
  } catch (error) {
    // No fence row: the preparation never reached data-manager.
    if (error instanceof DataManagerHttpError && error.status === 404) return;
    throw error;
  }
}
