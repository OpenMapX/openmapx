export const API_RESTART_PHASE = "awaiting-api-restart";

export interface ApiRestartCheckpoint {
  phase: typeof API_RESTART_PHASE;
  helperContainerId: string;
  previousContainerId: string;
  expectedImageId: string;
  outcomeFile: string;
}

export function apiRestartCheckpoint(result: unknown): ApiRestartCheckpoint | null {
  if (!result || typeof result !== "object") return null;
  const checkpoint = result as Partial<ApiRestartCheckpoint>;
  const valid =
    checkpoint.phase === API_RESTART_PHASE &&
    typeof checkpoint.helperContainerId === "string" &&
    /^[a-f0-9]{64}$/.test(checkpoint.helperContainerId) &&
    typeof checkpoint.previousContainerId === "string" &&
    /^[a-f0-9]{64}$/.test(checkpoint.previousContainerId) &&
    typeof checkpoint.expectedImageId === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(checkpoint.expectedImageId) &&
    typeof checkpoint.outcomeFile === "string" &&
    checkpoint.outcomeFile.length > 0;
  return valid ? (checkpoint as ApiRestartCheckpoint) : null;
}

export function isApiRestartCheckpoint(result: unknown): boolean {
  return apiRestartCheckpoint(result) !== null;
}
