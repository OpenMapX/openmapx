export const APP_API_RESTART_PHASE = "awaiting-app-api-restart";

export interface AppApiRestartCheckpoint {
  phase: typeof APP_API_RESTART_PHASE;
  helperContainerId: string;
  previousContainerId: string;
  expectedImageId: string;
  outcomeFile: string;
}

export function appApiRestartCheckpoint(result: unknown): AppApiRestartCheckpoint | null {
  if (!result || typeof result !== "object") return null;
  const checkpoint = result as Partial<AppApiRestartCheckpoint>;
  const valid =
    checkpoint.phase === APP_API_RESTART_PHASE &&
    typeof checkpoint.helperContainerId === "string" &&
    /^[a-f0-9]{64}$/.test(checkpoint.helperContainerId) &&
    typeof checkpoint.previousContainerId === "string" &&
    /^[a-f0-9]{64}$/.test(checkpoint.previousContainerId) &&
    typeof checkpoint.expectedImageId === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(checkpoint.expectedImageId) &&
    typeof checkpoint.outcomeFile === "string" &&
    checkpoint.outcomeFile.length > 0;
  return valid ? (checkpoint as AppApiRestartCheckpoint) : null;
}

export function isAppApiRestartCheckpoint(result: unknown): boolean {
  return appApiRestartCheckpoint(result) !== null;
}
