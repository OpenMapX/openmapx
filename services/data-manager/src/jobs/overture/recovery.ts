/** Readiness is advisory data; the existing worker lock and checks enforce writes. */
import type { OvertureRecoveryStatus } from "@openmapx/core/data-manager-contracts";
import { inspectOvertureLocalInputs } from "./local-inputs.js";
import { overtureOperationBusy } from "./operation-lock.js";
import { getOvertureConflationState } from "./rebuild-links.js";
export async function inspectOvertureRecovery(
  dataDir: string,
  region: string,
): Promise<OvertureRecoveryStatus> {
  const local = inspectOvertureLocalInputs(dataDir, region),
    [busy, installed] = await Promise.all([overtureOperationBusy(), getOvertureConflationState()]);
  const matching = installed?.region === region;
  const action = (reason: string | null) => ({
    allowed: !busy && reason === null,
    reason: busy ? "Another Overture operation holds the workspace lease." : reason,
  });
  const needInstalled = matching ? null : "Ingest this region's Places partition first.";
  const needOsm = local.osmAvailable ? null : "Download this region's OSM PBF first.";
  return {
    region,
    busy,
    ...local,
    installedRelease: installed?.release ?? null,
    actions: {
      "overture-pull": action(null),
      "overture-ingest": action(
        local.downloadedRelease
          ? null
          : "Download a completed release partition for this region first.",
      ),
      "overture-extract": action(needInstalled ?? needOsm),
      "overture-conflate": action(
        needInstalled ?? (installed?.status === "completed" ? null : needOsm),
      ),
      "overture-restart": action(needInstalled ?? needOsm),
    },
  };
}
export async function assertOvertureRecoveryInputs(
  dataDir: string,
  region: string,
  kind: "overture-ingest" | "overture-extract" | "overture-conflate",
  restart = false,
): Promise<string | null> {
  const local = inspectOvertureLocalInputs(dataDir, region);
  if (kind === "overture-ingest") {
    if (!local.downloadedRelease)
      throw Error("Download a completed release partition for this region before ingesting it.");
    return local.downloadedRelease;
  }
  const installed = await getOvertureConflationState();
  if (installed?.region !== region)
    throw Error("Ingest this region's Places partition before rebuilding its OSM workspace.");
  if (
    !local.osmAvailable &&
    (kind === "overture-extract" || restart || installed.status !== "completed")
  )
    throw Error("Download this region's OSM PBF before rebuilding its workspace.");
  return null;
}
