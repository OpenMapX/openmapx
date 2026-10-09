import { services as coreServices } from "@openmapx/core/server";
import { readDesiredSelection } from "./desired-selection";

const { expandServiceSelection, normalizeServiceIds, SERVICE_SELECTION_ENV } = coreServices;

// Leading char must be alphanumeric: this rejects "." / ".." (path traversal
// when the name is joined into the backups directory) and leading-dash names
// (argument-injection-shaped when forwarded as a CLI argv element). Mirrors the
// slug guard used for other CLI arguments in admin-job-handlers.ts.
const BACKUP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface ServiceSelectionSummary {
  source: "env" | "file" | "default";
  selectedRoots: string[];
  requestedIds: string[];
  effectiveIds: string[];
  warnings: string[];
  missingIds: string[];
  envVarName: string;
  envVarValue: string | null;
  selectionFilePath: string;
}

const SELECTION_FILE_PATH = `infra/docker/${coreServices.SERVICE_SELECTION_FILE}`;

/**
 * The operator's selection, as the CLI's `services selected` reports it: the
 * ops-agent reads it from the deployment, which this container cannot see.
 * `authoritativeRoots` describes a selection that was just applied.
 */
export async function getServiceSelectionSummary(
  registry: InstanceType<typeof coreServices.ServiceRegistry>,
  authoritativeRoots?: string[],
): Promise<ServiceSelectionSummary> {
  const desired: coreServices.DesiredSelection = authoritativeRoots
    ? { source: "file", roots: authoritativeRoots }
    : await readDesiredSelection();
  const selection = expandServiceSelection(registry.list(), desired.roots, {
    allowMissingSelected: desired.source === "default",
  });
  return {
    source: desired.source,
    selectedRoots: desired.roots,
    requestedIds: selection.requestedIds,
    effectiveIds: selection.enabledIdsOrdered,
    warnings: selection.warnings,
    missingIds: selection.missingIds,
    envVarName: SERVICE_SELECTION_ENV,
    envVarValue: desired.source === "env" ? desired.roots.join(",") : null,
    selectionFilePath: SELECTION_FILE_PATH,
  };
}

export async function validateServiceSelectionForWrite(
  registry: InstanceType<typeof coreServices.ServiceRegistry>,
  selected: string[],
): Promise<{ normalized: string[]; warnings: string[]; missingIds: string[] }> {
  if ((await readDesiredSelection()).source === "env") {
    throw new Error(
      `${SERVICE_SELECTION_ENV} is set; unset it before editing ${SELECTION_FILE_PATH}`,
    );
  }
  const normalized = normalizeServiceIds(selected);
  const selection = expandServiceSelection(registry.list(), normalized, {
    allowMissingSelected: false,
  });
  if (selection.missingIds.length > 0) {
    throw new Error(`Selected service(s) are not installed: ${selection.missingIds.join(", ")}`);
  }
  return { normalized, warnings: selection.warnings, missingIds: selection.missingIds };
}

export function assertValidBackupName(name: string): void {
  if (name.length > 128 || !BACKUP_NAME_RE.test(name)) {
    throw new Error(`Invalid backup name "${name}"`);
  }
}
