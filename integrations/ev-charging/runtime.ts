import type { IntegrationContext } from "@openmapx/integration-framework";

// Module-scoped holder mirrors `cache.ts`: the thin provider wrappers run inside
// the integration's setup-injected context, but the static-poi-reader is
// constructed at module-load time and needs the same ctx at call time. Storing
// it here avoids threading ctx through every search/fetchDetail signature on
// the EvChargingSource interface (which predates POI sources).
let _ctx: IntegrationContext | null = null;

export function initRuntime(ctx: IntegrationContext): void {
  _ctx = ctx;
}

export function getRuntimeContext(): IntegrationContext {
  if (!_ctx) {
    throw new Error(
      "ev-charging runtime: integration context not initialised — call initRuntime(ctx) in setup()",
    );
  }
  return _ctx;
}
