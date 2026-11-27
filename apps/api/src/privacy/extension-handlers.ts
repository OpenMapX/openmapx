import type { LoadedIntegration, SubjectDataHandler } from "@openmapx/integration-framework";
import type { IntegrationScope } from "../integration-scope";

/**
 * The subject-data handlers integrations registered and the live registry
 * they belong to. This module imports nothing at run time, so the privacy
 * catalogue, which the repository's checks load outside the API, can read
 * it.
 */

/**
 * The archive member, the export part, the operator task and the collector
 * id of an extension's export: `extension:<integration id>`. No catalogue
 * id, archive member or integration id can contain `:`, so these never
 * collide with a catalogue entry, whatever the integration is called.
 */
export const EXTENSION_LOGICAL_ID_PREFIX = "extension:";

export interface RegisteredSubjectDataHandler {
  readonly scope: IntegrationScope;
  readonly erase: (subjectId: string) => unknown;
  readonly export: (subjectId: string) => unknown;
}

/** Where catalogue and handler code write warnings; pino's argument order. */
export interface SubjectDataLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The handler each loaded integration registered, keyed by the generation's
 * record of it: a reload builds new records, so a staged generation never
 * replaces the handler of the one that is serving, and a discarded one
 * leaves nothing behind.
 */
const handlers = new WeakMap<LoadedIntegration, RegisteredSubjectDataHandler>();

/**
 * Records `handler` as `integration`'s subject-data handler, to be called in
 * `scope`. The methods are read once, here, so the handler cannot swap them
 * later. Throws for a second registration and for a handler without both
 * methods.
 */
export function registerSubjectDataHandlerFor(
  integration: LoadedIntegration,
  scope: IntegrationScope,
  handler: SubjectDataHandler,
): void {
  if (handlers.has(integration))
    throw new Error(`Integration ${integration.id} already registered a subject-data handler`);
  const erase = handler?.erase;
  const exportData = handler?.export;
  if (typeof erase !== "function" || typeof exportData !== "function")
    throw new Error(
      `Integration ${integration.id} registered a subject-data handler without export and erase`,
    );
  handlers.set(integration, {
    scope,
    erase: (subjectId) => Reflect.apply(erase, handler, [subjectId]),
    export: (subjectId) => Reflect.apply(exportData, handler, [subjectId]),
  });
}

/** Forgets the handler of an integration whose load is undone. */
export function forgetSubjectDataHandler(integration: LoadedIntegration): void {
  handlers.delete(integration);
}

/** Whether `integration` registered a handler, running or not. */
export function hasSubjectDataHandler(integration: LoadedIntegration): boolean {
  return handlers.has(integration);
}

/** Whether `integration` is loaded and runs its code; a disabled one keeps its last load state. */
export function integrationRuns(integration: LoadedIntegration): boolean {
  return integration.loadState === "loaded" && integration.enabled;
}

/** The handler of an integration that is loaded and running, if it registered one. */
export function runningSubjectDataHandler(
  integration: LoadedIntegration,
): RegisteredSubjectDataHandler | undefined {
  return integrationRuns(integration) ? handlers.get(integration) : undefined;
}

let integrationSource: (() => readonly LoadedIntegration[]) | null = null;
const silent: SubjectDataLog = { warn: () => {} };
let log: SubjectDataLog = silent;

/** Called by the integration host with its live registry and its logger. */
export function setSubjectDataIntegrationSource(
  source: (() => readonly LoadedIntegration[]) | null,
  logger: SubjectDataLog = silent,
): void {
  integrationSource = source;
  log = logger;
}

/** Every integration of the live generation, loaded or not; `null` outside the API. */
export function installedIntegrations(): readonly LoadedIntegration[] | null {
  return integrationSource?.() ?? null;
}

export function subjectDataLog(): SubjectDataLog {
  return log;
}
