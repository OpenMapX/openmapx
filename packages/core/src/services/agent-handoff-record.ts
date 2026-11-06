import type { OpsAgentHandoffPhase } from "../ops/contract";
export type AgentHandoffPhase = Exclude<OpsAgentHandoffPhase, "none">;
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PHASES = new Set<AgentHandoffPhase>([
  "launched",
  "overlay_written",
  "recreated",
  "applied",
  "rolled_back",
  "failed",
]);
export interface AgentHandoffRecord {
  version: 1;
  handoffId: string;
  releaseId: string;
  digest: string;
  phase: AgentHandoffPhase;
  /** Overlay bytes before the handoff, restored on rollback; null when absent. */
  previousOverlay: string | null;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  /** Set once a release application has used this handoff's previous overlay. */
  consumed?: boolean;
  /**
   * Set on a handoff imported from an earlier release's state location. Its
   * helper keeps recording there, so this agent settles it once that helper
   * has exited.
   */
  importedFromLegacy?: boolean;
}

export function parseAgentHandoffRecord(raw: string): AgentHandoffRecord {
  const value = JSON.parse(raw) as Partial<AgentHandoffRecord> | null;
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.handoffId !== "string" ||
    !HANDOFF_ID.test(value.handoffId) ||
    typeof value.releaseId !== "string" ||
    !HANDOFF_ID.test(value.releaseId) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase) ||
    !(value.previousOverlay === null || typeof value.previousOverlay === "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !(value.reason === undefined || typeof value.reason === "string") ||
    !(value.consumed === undefined || typeof value.consumed === "boolean") ||
    !(value.importedFromLegacy === undefined || typeof value.importedFromLegacy === "boolean")
  ) {
    throw new Error("Agent handoff record rejected");
  }
  return value as AgentHandoffRecord;
}
