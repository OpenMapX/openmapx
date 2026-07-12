"use client";

import { type ComponentType, lazy } from "react";

/**
 * Lazy loaders for the crowd-reports integration's client UI.
 *
 * Loaded through a non-analyzable dynamic import (the integration id is computed
 * at runtime), mirroring `MapLayerHost`. This keeps the integration's React tree
 * — and its ES2024 device-signing lib (`@openmapx/openconditions-contrib-client`,
 * which uses BigInt literals) — out of apps/web's ES2017 `tsc` program, while the
 * bundler still globs the integration directory for the chunk. Each component has
 * a single named export, resolved to a default below.
 */
const id = ["crowd", "reports"].join("-");

function firstExport(mod: Record<string, unknown>): { default: ComponentType } {
  const Component = Object.values(mod).find((v) => typeof v === "function") as ComponentType;
  return { default: Component };
}

export const ReportFabLazy = lazy(() => import(`@integrations/${id}/ReportFab`).then(firstExport));
export const ReportDialogLazy = lazy(() =>
  import(`@integrations/${id}/ReportDialog`).then(firstExport),
);
export const CrowdApproachPromptLazy = lazy(() =>
  import(`@integrations/${id}/CrowdApproachPrompt`).then(firstExport),
);
