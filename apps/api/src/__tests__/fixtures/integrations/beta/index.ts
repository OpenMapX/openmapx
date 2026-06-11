import type { IntegrationContext } from "@openmapx/integration-framework";

declare global {
  var __fixtureSetupOrder: string[] | undefined;
}

export function setup(_ctx: IntegrationContext): void {
  globalThis.__fixtureSetupOrder ??= [];
  globalThis.__fixtureSetupOrder.push("beta");
}
