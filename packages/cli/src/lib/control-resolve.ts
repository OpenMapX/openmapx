import {
  AnchoredDirectory,
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
import {
  canonicalJson,
  type MaintenanceFenceOutcome,
  transitionMaintenance,
} from "@openmapx/core/ops";
import { z } from "zod";
import { cliDataManagerToken } from "./data-manager-token";
import { dataManagerUrl } from "./data-manager-url";
import { configurationHelperMayRun } from "./docker";

/** What the agent records on a maintenance's fence child for this settle. */
const fenceEvidenceSchema = z.object({
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  planDigest: z.string(),
});

/** The agent's record of the maintenance, read and written with the agent's own
 * anchored, no-follow I/O. It is written only while it needs recovery: the
 * agent changes a record in that state only through this resolution. */
function maintenanceRecord(infraDir: string, maintenanceId: string) {
  const name = maintenanceFileName(maintenanceId);
  const withDirectory = <T>(run: (directory: AnchoredDirectory) => T): T => {
    const root = new AnchoredDirectory(controlPrivateRoot(infraDir, "ops-agent"));
    try {
      const directory = root.directory(MAINTENANCE_NAMESPACE, false, true);
      try {
        return run(directory);
      } finally {
        directory.close();
      }
    } finally {
      root.close();
    }
  };
  let file: ReturnType<typeof parseMaintenanceFile>;
  try {
    file = withDirectory((directory) =>
      parseMaintenanceFile(
        JSON.parse(directory.read(name, 131072).toString("utf8")),
        maintenanceId,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const write = (record: typeof file.record) => {
    const next = maintenanceFileSchema.parse({ ...file, record });
    withDirectory((directory) => directory.write(name, canonicalJson(next)));
    file.record = next.record;
  };
  return { file, write };
}

/**
 * Settles the data-manager fence of a maintenance the operator resolves. The
 * settle inputs come from the fence child in the agent's lease store; the
 * request goes the way the CLI's other data-manager calls go, with the CLI's
 * own token, which data-manager accepts as the operator's resolution. A
 * maintenance record that needs recovery moves to settling first; once the
 * record has fixed the fence's outcome, that outcome is sent, whatever the
 * operator answered. A record that needs recovery is settled once data-manager
 * answers. A fence that was never prepared needs nothing. While the helper of
 * an attempted handoff may still run, nothing is resolved.
 */
export async function settleMaintenanceFence(
  infraDir: string,
  lease: LeaseRecord,
  as: "committed" | "failed",
  helperMayRun: (handoffId: string) => Promise<boolean> = configurationHelperMayRun,
): Promise<void> {
  const fence = lease.children.find((child) => child.phase === "configuration-fence");
  if (!fence) return;
  const evidence = fenceEvidenceSchema.parse(fence.evidence);
  const maintenance = maintenanceRecord(infraDir, evidence.maintenanceId);
  const current = maintenance?.file.record;
  if (
    current?.state === "applying" &&
    current.handoff &&
    current.steps.at(-1)?.phase === "maintenance-handoff" &&
    current.steps.at(-1)?.state === "attempted" &&
    (await helperMayRun(current.handoff.handoffId))
  )
    throw new Error(
      "The configuration helper of this maintenance may still replace services. Wait until its container exited (the agent then records its outcome), then resolve again.",
    );
  let outcome: MaintenanceFenceOutcome = as === "committed" ? "applied" : "contained";
  if (maintenance?.file.record.state === "recovery_required") {
    const resolved = transitionMaintenance(
      maintenance.file.record,
      { type: "resolve", as },
      new Date(),
    );
    maintenance.write(resolved.record);
  }
  if (maintenance?.file.record.fenceOutcome) outcome = maintenance.file.record.fenceOutcome;
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
