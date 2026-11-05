import type { DataExecutionResult } from "@openmapx/core/data-manager-contracts";
import { applyHardlinkPlan } from "@openmapx/hardlinks";
import type { DataExecutionContext } from "./runtime.js";
import { publishDataChange } from "./worker-scope.js";
/** Generation leaf: the only I/O is the confined, root-fixed plan. It never
 * creates/restarts a container or obtains a host configuration writer. */
export async function applyOwnedGenerationHardlinks(
  context: DataExecutionContext,
): Promise<DataExecutionResult> {
  const journal = context.store.controlJournal;
  if (!journal) throw Error("Durable generation journal is unavailable");
  const record = await context.record();
  if (record.input.kind !== "generation-hardlinks") throw Error("Generation leaf required");
  const plan = await journal.readHardlinksPlan(context.execution);
  context.assertForward();
  const applied = await publishDataChange(() =>
    applyHardlinkPlan(plan.plan, { rootDir: context.dataRoot, prune: true }),
  );
  return {
    kind: "generation-hardlinks",
    hardlinks: {
      applied: true,
      entries: plan.plan.length,
      linked: applied.linked,
      skipped: applied.skipped,
      pruned: applied.pruned,
      via: "data-manager",
    },
  };
}
