/** Unit stage I/O collaborator only. This exercises directory/probe/rollback
 * semantics; production authority is qualified by real SQL/separate processes. */
import type { DataOpsChildPhase } from "../../src/jobs/execution/ops-children.js";
import { publishDataChange } from "../../src/jobs/execution/worker-scope.js";
import type { JobContext } from "../../src/jobs/transitous/types.js";
import { runOpsOperation } from "../../src/ops-client.js";
export function assertTransitForward(ctx: JobContext) {
  ctx.abortSignal.throwIfAborted();
}
export function retainTransitPhaseCandidate() {
  return Promise.resolve();
}
/** No dispatch ticket is fabricated by this I/O-only unit collaborator. */
export function reserveTransitProxyRecovery() {
  return Promise.resolve();
}
export async function publishTransitChange<T>(
  ctx: JobContext,
  run: () => T | Promise<T>,
): Promise<T> {
  assertTransitForward(ctx);
  return publishDataChange(run);
}
export async function runTransitOwnedPhase(ctx: JobContext, phase: DataOpsChildPhase) {
  assertTransitForward(ctx);
  switch (phase) {
    case "stop-primary":
      return runOpsOperation({ kind: "motis.primary.stop" });
    case "stop-staging":
      return runOpsOperation({ kind: "motis.staging.stop" });
    case "restart-staging":
      return runOpsOperation({ kind: "motis.staging.restart" });
    case "promote-primary":
      return runOpsOperation({ kind: "motis.primary.promote", preparedRunId: ctx.jobId });
    case "recover-primary":
      return runOpsOperation({ kind: "motis.primary.restart" });
    case "proxy-stage":
    case "proxy-commit":
    case "proxy-restore":
      return runOpsOperation({ kind: "feedProxy.validateAndReload", candidateId: `unit-${phase}` });
    default:
      throw Error("Closed unit phase");
  }
}
