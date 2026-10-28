/** Finite non-recreating coordinator Start inside existing writer/target ownership. */
import {
  assertArtifactTargetLeaseForward,
  assertControlExecutionForward,
} from "@openmapx/core/build-artifacts";
import {
  type DataManagerTransport,
  getStatus,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import type { CoordinatorMode } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { dockerComposeStream } from "./docker";
export async function ensureCliCoordinatorReady(options: {
  ownership: services.VerifiedLifecycleOwnership;
  transport: DataManagerTransport;
  mode: CoordinatorMode;
}) {
  const authority = services.assertVerifiedLifecycleOwnership(options.ownership);
  if (!options.ownership.lease.serviceIds.includes("data-manager"))
    throw Error("Coordinator target ownership required");
  const forward = () => {
    assertControlExecutionForward(authority);
    assertArtifactTargetLeaseForward(options.ownership.lease);
  };
  const ready = async () => {
    try {
      return unwrapDataManagerResponse(await getStatus({ transport: options.transport })).ok;
    } catch {
      return false;
    }
  };
  forward();
  if (await ready()) return;
  if (options.mode !== "ensure-running") throw Error("Configuration coordinator unavailable");
  forward();
  const code = await dockerComposeStream(["up", "-d", "--no-recreate", "data-manager"]);
  if (code !== 0) throw Error("Configuration coordinator Start failed");
  const until = Math.min(Date.now() + 30000, authority.execution.deadlineAt);
  while (!(await ready())) {
    forward();
    if (Date.now() >= until) throw Error("Configuration coordinator unavailable");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  forward();
}
