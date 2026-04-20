import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { repoPaths } from "./paths";

const {
  DEFAULT_SELECTED_SERVICE_IDS,
  expandServiceSelection,
  normalizeServiceIds,
  parseServiceIdList,
  SERVICE_SELECTION_ENV,
} = coreServices;

type ServiceRegistry = InstanceType<typeof coreServices.ServiceRegistry>;
type ExpandedServiceSelection = coreServices.ExpandedServiceSelection;

export const SERVICE_SELECTION_FILE = "service-selection.json";

export interface ServiceSelectionState {
  selected: string[];
}

export interface AppliedServiceSelection {
  source: "explicit" | "env" | "file" | "default";
  requestedIds: string[];
  selection: ExpandedServiceSelection;
}

interface ApplyServiceSelectionOptions {
  rootDir?: string;
  explicitIds?: Iterable<string> | null;
}

export function serviceSelectionPath(rootDir?: string): string {
  return join(repoPaths(rootDir).infraDir, SERVICE_SELECTION_FILE);
}

export function readServiceSelection(rootDir?: string): ServiceSelectionState | null {
  const path = serviceSelectionPath(rootDir);
  if (!existsSync(path)) return null;

  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ServiceSelectionState>;
  if (!Array.isArray(raw.selected)) {
    throw new Error(`Malformed service selection file at ${path}: expected "selected" array`);
  }

  return { selected: normalizeServiceIds(raw.selected) };
}

export function writeServiceSelection(state: ServiceSelectionState, rootDir?: string): void {
  const path = serviceSelectionPath(rootDir);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ selected: normalizeServiceIds(state.selected) }, null, 2),
    "utf-8",
  );
}

function requestedIdsFromInputs(opts: ApplyServiceSelectionOptions): {
  source: AppliedServiceSelection["source"];
  ids: string[];
} {
  if (opts.explicitIds) {
    return { source: "explicit", ids: normalizeServiceIds(opts.explicitIds) };
  }

  const fromEnv = parseServiceIdList(process.env[SERVICE_SELECTION_ENV]);
  if (fromEnv) {
    return { source: "env", ids: fromEnv };
  }

  const fromFile = readServiceSelection(opts.rootDir);
  if (fromFile) {
    return { source: "file", ids: fromFile.selected };
  }

  return { source: "default", ids: [...DEFAULT_SELECTED_SERVICE_IDS] };
}

export function applyServiceSelection(
  registry: ServiceRegistry,
  opts: ApplyServiceSelectionOptions = {},
): AppliedServiceSelection {
  const requested = requestedIdsFromInputs(opts);
  const selection = expandServiceSelection(registry.list(), requested.ids, {
    allowMissingSelected: requested.source === "default",
  });

  if (selection.missingIds.length > 0) {
    throw new Error(`Selected service(s) are not installed: ${selection.missingIds.join(", ")}`);
  }

  registry.applyEnabledIds(selection.enabledIds);
  return {
    source: requested.source,
    requestedIds: selection.requestedIds,
    selection,
  };
}

export async function loadRegistryWithSelection(opts: ApplyServiceSelectionOptions = {}): Promise<{
  registry: ServiceRegistry;
  applied: AppliedServiceSelection;
}> {
  const paths = repoPaths(opts.rootDir);
  const registry = new coreServices.ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  return { registry, applied: applyServiceSelection(registry, { ...opts, rootDir: paths.root }) };
}

export async function getServiceSelectionSummary(
  rootDir?: string,
): Promise<AppliedServiceSelection> {
  const { applied } = await loadRegistryWithSelection({ rootDir });
  return applied;
}

export function selectedRootsForEdit(rootDir?: string): string[] {
  const fromEnv = parseServiceIdList(process.env[SERVICE_SELECTION_ENV]);
  if (fromEnv) {
    throw new Error(
      `${SERVICE_SELECTION_ENV} is set; unset it before editing ${SERVICE_SELECTION_FILE}`,
    );
  }

  return readServiceSelection(rootDir)?.selected ?? [...DEFAULT_SELECTED_SERVICE_IDS];
}

export function enableSelectedServices(
  ids: Iterable<string>,
  rootDir?: string,
): ServiceSelectionState {
  const selected = normalizeServiceIds([...selectedRootsForEdit(rootDir), ...ids]);
  writeServiceSelection({ selected }, rootDir);
  return { selected };
}

export function disableSelectedServices(
  ids: Iterable<string>,
  rootDir?: string,
): ServiceSelectionState {
  const disabled = new Set(normalizeServiceIds(ids));
  const selected = selectedRootsForEdit(rootDir).filter((id) => !disabled.has(id));
  writeServiceSelection({ selected }, rootDir);
  return { selected };
}
