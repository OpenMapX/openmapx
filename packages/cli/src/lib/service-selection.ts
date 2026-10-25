import { services as coreServices } from "@openmapx/core/server";
import { repoPaths } from "./paths";

const {
  DEFAULT_SELECTED_SERVICE_IDS,
  expandServiceSelection,
  normalizeServiceIds,
  parseServiceIdList,
  readDesiredSelection,
  readServiceSelectionFile,
  SERVICE_SELECTION_ENV,
  writeServiceSelectionFile,
} = coreServices;

type ServiceRegistry = InstanceType<typeof coreServices.ServiceRegistry>;
type ExpandedServiceSelection = coreServices.ExpandedServiceSelection;

export const SERVICE_SELECTION_FILE = coreServices.SERVICE_SELECTION_FILE;

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
  return coreServices.serviceSelectionPath(repoPaths(rootDir).infraDir);
}

export function readServiceSelection(rootDir?: string): ServiceSelectionState | null {
  const selected = readServiceSelectionFile(repoPaths(rootDir).infraDir);
  return selected ? { selected } : null;
}

export function writeServiceSelection(state: ServiceSelectionState, rootDir?: string): void {
  writeServiceSelectionFile(repoPaths(rootDir).infraDir, state.selected);
}

function requestedIdsFromInputs(opts: ApplyServiceSelectionOptions): {
  source: AppliedServiceSelection["source"];
  ids: string[];
} {
  if (opts.explicitIds) {
    return { source: "explicit", ids: normalizeServiceIds(opts.explicitIds) };
  }
  const desired = readDesiredSelection(repoPaths(opts.rootDir).infraDir);
  return { source: desired.source, ids: desired.roots };
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

/**
 * Read, change and write the selection under the configuration writer lock, so
 * an edit never interleaves with a render or the agent's apply, which read and
 * write the same file.
 */
async function editSelectedServices(
  edit: (selected: string[]) => string[],
  rootDir?: string,
): Promise<ServiceSelectionState> {
  const release = await coreServices.acquireConfigurationOwnership(repoPaths(rootDir).infraDir);
  try {
    const selected = edit(selectedRootsForEdit(rootDir));
    writeServiceSelection({ selected }, rootDir);
    return { selected };
  } finally {
    release();
  }
}

export function enableSelectedServices(
  ids: Iterable<string>,
  rootDir?: string,
): Promise<ServiceSelectionState> {
  const added = [...ids];
  return editSelectedServices((selected) => normalizeServiceIds([...selected, ...added]), rootDir);
}

export function disableSelectedServices(
  ids: Iterable<string>,
  rootDir?: string,
): Promise<ServiceSelectionState> {
  const disabled = new Set(normalizeServiceIds(ids));
  return editSelectedServices((selected) => selected.filter((id) => !disabled.has(id)), rootDir);
}
