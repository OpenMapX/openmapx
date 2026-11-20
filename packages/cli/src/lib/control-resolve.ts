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
  inspectDataConfigurationFence,
  settleDataConfigurationFence,
} from "@openmapx/core/data-manager-sdk";
import {
  canonicalJson,
  type MaintenanceEvent,
  type MaintenanceFenceOutcome,
  transitionMaintenance,
} from "@openmapx/core/ops";
import { z } from "zod";
import { cliDataManagerToken } from "./data-manager-token";
import { dataManagerUrl } from "./data-manager-url";

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
 * maintenance the agent still drives (preparing, prepared or applying) is
 * refused: the agent finishes it, or marks it as needing recovery when it
 * cannot. A record that needs recovery moves to settling first; once the
 * record has fixed the fence's outcome, that outcome is sent, whatever the
 * operator answered. The record is settled once data-manager answers, or once
 * it refuses the settlement for good (it has no such fence, or settled it
 * otherwise). A refusal that leaves the fence prepared fails the resolution.
 * A fence that was never prepared needs nothing.
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
  const state = maintenance?.file.record.state;
  if (state === "preparing" || state === "prepared" || state === "applying")
    throw new Error(
      `The agent is still driving this maintenance (${state}): it finishes it on its own, or records that it needs recovery when it cannot, as it does when it restarts. Wait, check \`openmapx control status\` again, and resolve it then.`,
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
  const transport = createDataManagerTransport({
    baseUrl: dataManagerUrl(),
    authToken: cliDataManagerToken(),
    requestTimeoutMs: 15000,
    maxJsonBytes: 65536,
  });
  let event: MaintenanceEvent;
  try {
    const settled = await settleDataConfigurationFence({ ...evidence, outcome }, { transport });
    event = { type: "fence_settled", fence: settled };
  } catch (error) {
    if (!(error instanceof DataManagerHttpError) || (error.status !== 404 && error.status !== 409))
      throw error;
    // A refusal for good ends the maintenance only when nothing is left
    // fenced: no fence row (the preparation never reached data-manager), or a
    // row data-manager settled otherwise. A row still prepared keeps every data
    // job refused, so the resolution stops and says so.
    if (error.status === 409) {
      const current = await inspectDataConfigurationFence(evidence.maintenanceId, {
        transport,
        candidateId: evidence.candidateId,
      });
      if (current.state !== "settled")
        throw new Error(
          `Data-manager refused to settle the fence of maintenance ${evidence.maintenanceId} (${error.message}) and still holds it ${current.state} for revision ${current.revisionId}: no data job runs until it is settled. The agent's record of this maintenance no longer matches data-manager's fence; inspect both before resolving it again.`,
        );
    }
    event = { type: "operator_settled" };
  }
  if (maintenance?.file.record.state === "settling")
    maintenance.write(transitionMaintenance(maintenance.file.record, event, new Date()).record);
}
