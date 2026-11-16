import type { ArtifactTargetLease } from "@openmapx/core/build-artifacts";
import type { DataExecutionContext } from "./runtime.js";

/** The execution's own lease; only a hardlink leaf has none. */
export function ownedLease(
  context: Pick<DataExecutionContext, "targetAuthority">,
): ArtifactTargetLease {
  if (!context.targetAuthority) throw Error("This execution holds no lease of its own");
  return context.targetAuthority;
}
