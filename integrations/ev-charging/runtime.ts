import type { IntegrationContext } from "@openmapx/integration-framework";

// Module-scoped holder mirrors `cache.ts`: the thin provider wrappers run inside
// the integration's setup-injected context, but the static-poi-reader is
// constructed at module-load time and needs the same ctx at call time. Storing
// it here avoids threading ctx through every search/fetchDetail signature on
// the EvChargingSource interface (which predates POI sources).
let _ctx: IntegrationContext | null = null;
let staging = false;
let stagedCtx: IntegrationContext | null = null;
let stagedCommitActions: Array<() => void> | null = null;

export function initRuntime(ctx: IntegrationContext): void {
  if (staging) stagedCtx = ctx;
  else _ctx = ctx;
}

export function beginRuntimeStaging(): void {
  if (staging) throw new Error("ev-charging runtime staging is already active");
  staging = true;
  stagedCtx = null;
  stagedCommitActions = [];
}

/** Defer module-global configuration changes until the staged generation wins. */
export function stageRuntimeCommit(action: () => void): void {
  if (!staging) {
    action();
    return;
  }
  if (!stagedCommitActions) {
    throw new Error("ev-charging runtime staging actions are not initialised");
  }
  stagedCommitActions.push(action);
}

export function commitRuntimeStaging(): void {
  if (!staging) throw new Error("ev-charging runtime staging is not active");
  const commitActions = stagedCommitActions;
  if (!commitActions) {
    throw new Error("ev-charging runtime staging actions are not initialised");
  }
  _ctx = stagedCtx;
  stagedCtx = null;
  stagedCommitActions = null;
  staging = false;
  for (const action of commitActions) action();
}

export function rollbackRuntimeStaging(): void {
  stagedCtx = null;
  stagedCommitActions = null;
  staging = false;
}

export function getRuntimeContext(): IntegrationContext {
  if (!_ctx) {
    throw new Error(
      "ev-charging runtime: integration context not initialised — call initRuntime(ctx) in setup()",
    );
  }
  return _ctx;
}
