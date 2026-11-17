import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  controlPrivateRoot,
  type LeaseRecord,
  MAINTENANCE_NAMESPACE,
  maintenanceFileName,
  maintenanceFileSchema,
  parseMaintenanceFile,
} from "@openmapx/core/build-artifacts";
import {
  createDataManagerTransport,
  DataManagerHttpError,
  settleDataConfigurationFence,
} from "@openmapx/core/data-manager-sdk";
import { type MaintenanceFenceOutcome, transitionMaintenance } from "@openmapx/core/ops";
import { z } from "zod";
import { cliDataManagerToken } from "./data-manager-token";
import { dataManagerUrl } from "./data-manager-url";

/** What the agent records on a maintenance's fence child for this settle. */
const fenceEvidenceSchema = z.object({
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  planDigest: z.string(),
});

/** The agent's record of the maintenance, written only when it needs recovery:
 * the agent changes a record in that state only through this resolution. */
function maintenanceRecord(infraDir: string, maintenanceId: string) {
  const path = join(
    controlPrivateRoot(infraDir, "ops-agent"),
    MAINTENANCE_NAMESPACE,
    maintenanceFileName(maintenanceId),
  );
  if (!existsSync(path)) return undefined;
  const file = parseMaintenanceFile(JSON.parse(readFileSync(path, "utf8")), maintenanceId);
  const write = (record: typeof file.record) => {
    const next = maintenanceFileSchema.parse({ ...file, record });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    file.record = next.record;
  };
  return { file, write };
}

/**
 * Settles the data-manager fence of a maintenance the operator resolves. The
 * settle inputs come from the fence child in the agent's lease store; the
 * request goes the way the CLI's other data-manager calls go, with the CLI's
 * own token, which data-manager accepts as the operator's resolution. A
 * maintenance record that needs recovery moves to settling first, so its
 * outcome decides the fence's, and is settled once data-manager answers. A
 * fence that was never prepared needs nothing.
 */
export async function settleMaintenanceFence(
  infraDir: string,
  lease: LeaseRecord,
  as: "committed" | "failed",
): Promise<void> {
  const fence = lease.children.find((child) => child.phase === "configuration-fence");
  if (!fence) return;
  const evidence = fenceEvidenceSchema.parse(fence.evidence);
  const maintenance = maintenanceRecord(infraDir, evidence.maintenanceId);
  let outcome: MaintenanceFenceOutcome = as === "committed" ? "applied" : "contained";
  if (maintenance?.file.record.state === "recovery_required") {
    const resolved = transitionMaintenance(
      maintenance.file.record,
      { type: "resolve", as },
      new Date(),
    );
    maintenance.write(resolved.record);
  }
  if (maintenance?.file.record.state === "settling" && maintenance.file.record.fenceOutcome)
    outcome = maintenance.file.record.fenceOutcome;
  let settled: Awaited<ReturnType<typeof settleDataConfigurationFence>>;
  try {
    settled = await settleDataConfigurationFence(
      { ...evidence, outcome },
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
  if (maintenance?.file.record.state === "settling" && settled?.state === "settled")
    maintenance.write(
      transitionMaintenance(
        maintenance.file.record,
        { type: "fence_settled", fence: settled },
        new Date(),
      ).record,
    );
}
