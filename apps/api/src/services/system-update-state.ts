export const APP_API_RESTART_PHASE = "awaiting-app-api-restart";

export function isAppApiRestartCheckpoint(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return (result as { phase?: unknown }).phase === APP_API_RESTART_PHASE;
}
