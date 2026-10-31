import { AsyncLocalStorage } from "node:async_hooks";
import type * as schema from "../db/schema";
import type { getAllIntegrations } from "../integration-host";
import type { getServiceRegistry } from "./service-registry";

const readBrand: unique symbol = Symbol("administrative configuration read");
export interface AdministrativeConfigurationReadContext {
  readonly [readBrand]: true;
  readonly services: readonly ReturnType<ReturnType<typeof getServiceRegistry>["list"]>[number][];
  readonly integrations: readonly ReturnType<typeof getAllIntegrations>[number][];
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly serviceRows: readonly (typeof schema.serviceConfig.$inferSelect)[];
  readonly integrationRows: readonly (typeof schema.integrationConfig.$inferSelect)[];
  readonly serviceSecretRows: readonly (typeof schema.serviceSecret.$inferSelect)[];
  readonly integrationSecretRows: readonly (typeof schema.integrationSecret.$inferSelect)[];
  /** Actual transaction rows include PostgreSQL xmin for delete/reinsert CAS. */
  readonly bindingRows?: readonly (typeof schema.capabilityBinding.$inferSelect & {
    _rowVersion?: string;
  })[];
  readonly bindingRevisionRows?: readonly (typeof schema.integrationBindingRevision.$inferSelect & {
    _rowVersion?: string;
  })[];
  /** Original candidate's proposed map, used only for its captured reload. */
  readonly integrationBindingSnapshot?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Only the committed-candidate reload scope supplies an already resolved snapshot. */
  readonly integrationReloadSnapshot?: Readonly<
    Record<string, Readonly<Record<string, import("../integration-config").ConfigValueWithSource>>>
  >;
}
const readers = new WeakSet<AdministrativeConfigurationReadContext>();
const scopes = new AsyncLocalStorage<AdministrativeConfigurationReadContext>();
const files = new WeakMap<AdministrativeConfigurationReadContext, Map<string, unknown>>();
export function openAdministrativeConfigurationRead(
  input: Omit<AdministrativeConfigurationReadContext, typeof readBrand>,
): AdministrativeConfigurationReadContext {
  const context = Object.freeze({ ...input, [readBrand]: true as const });
  readers.add(context);
  files.set(context, new Map());
  return context;
}
export function closeAdministrativeConfigurationRead(
  context: AdministrativeConfigurationReadContext,
): void {
  readers.delete(context);
}
export function assertAdministrativeConfigurationRead(
  context: AdministrativeConfigurationReadContext,
): void {
  if (!readers.has(context) || scopes.getStore() !== context)
    throw new Error("Configuration acquisition unavailable");
}
export function recordAdministrativeConfigurationFile(
  context: AdministrativeConfigurationReadContext,
  path: string,
  identity: unknown,
): void {
  assertAdministrativeConfigurationRead(context);
  const observed = files.get(context)!;
  if (observed.has(path) && JSON.stringify(observed.get(path)) !== JSON.stringify(identity))
    throw new Error("Configuration acquisition unavailable");
  observed.set(path, identity);
}
export function administrativeConfigurationFileObservations(
  context: AdministrativeConfigurationReadContext,
) {
  assertAdministrativeConfigurationRead(context);
  return [...files.get(context)!.entries()].sort(([a], [b]) => a.localeCompare(b));
}
export function withAdministrativeConfigurationReadScope<T>(
  context: AdministrativeConfigurationReadContext,
  run: () => Promise<T>,
): Promise<T> {
  if (!readers.has(context)) throw new Error("Configuration acquisition unavailable");
  return scopes.run(context, run);
}
