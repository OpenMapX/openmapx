// Data-manager's HTTP `/link` endpoint applies a hardlink plan. The logic is
// the same one the CLI uses on the host — shared through `@openmapx/hardlinks`
// so prune semantics can't drift between the two invocation paths.

import {
  type ApplyHardlinkOptions,
  type ApplyHardlinkResult,
  applyHardlinkPlan as applySharedHardlinkPlan,
  type HardlinkEntry,
} from "@openmapx/hardlinks";

export type { ApplyHardlinkOptions, ApplyHardlinkResult, HardlinkEntry };

export async function applyHardlinkPlan(
  plan: HardlinkEntry[],
  opts: ApplyHardlinkOptions,
): Promise<ApplyHardlinkResult> {
  return applySharedHardlinkPlan(plan, opts);
}
