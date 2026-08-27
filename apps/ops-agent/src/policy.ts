import {
  authorizeOpsResources,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResourcePolicy,
} from "@openmapx/core/ops";
import type { OpsTrustedClaim } from "./runtime";

export interface OpsClaimOwner {
  role: "api" | "data-manager";
  operationKey: string;
}

export interface OpsResourceClaimer {
  claim(
    operation: OpsOperation,
    fingerprint: string,
    signal: AbortSignal,
    owner?: OpsClaimOwner,
  ): Promise<OpsTrustedClaim | null>;
}

export interface TrustedOpsDataSource {
  claim(
    operation: OpsOperation,
    fingerprint: string,
    signal: AbortSignal,
    owner?: OpsClaimOwner,
  ): Promise<
    | OpsTrustedClaim["capability"]
    | {
        capability: OpsTrustedClaim["capability"];
        admission: NonNullable<OpsTrustedClaim["admission"]>;
      }
    | null
  >;
}

export const denyAllTrustedOpsData: TrustedOpsDataSource = {
  claim: async () => null,
};

const genericLifecycleKinds = new Set<OpsOperationKind>([
  "service.start",
  "service.stop",
  "service.restart",
  "service.recreate",
  "service.recreateIsolated",
  "service.pull",
  "service.remove",
  "service.update",
  "service.build",
  "service.logs",
  "service.logs.follow",
]);
const neverGenericLifecycle = new Set(["ops-agent", "traefik", "app-api"]);

export function createRegistryResourcePolicy(options: {
  serviceIds: Iterable<string>;
  enabledServiceIds?: () => ReadonlySet<string>;
  integrationIds: Iterable<string>;
  trustedData: TrustedOpsDataSource;
  resourceAuthority?: Pick<
    OpsResourcePolicy,
    | "allowBackup"
    | "allowRelease"
    | "allowRegion"
    | "allowCountry"
    | "allowDataType"
    | "allowCatalogRevision"
    | "allowUpdateJobId"
  >;
}): OpsResourcePolicy {
  const services = new Set(options.serviceIds);
  const integrations = new Set(options.integrationIds);
  return {
    allowGlobal: () => true,
    allowService: (kind, serviceId) =>
      services.has(serviceId) &&
      (!genericLifecycleKinds.has(kind) ||
        (options.enabledServiceIds?.().has(serviceId) ?? true)) &&
      !(genericLifecycleKinds.has(kind) && neverGenericLifecycle.has(serviceId)),
    allowBackup: options.resourceAuthority?.allowBackup ?? (() => false),
    allowPreparedRun: () => false,
    allowCandidate: () => false,
    allowRelease: options.resourceAuthority?.allowRelease ?? (() => false),
    allowRegion: options.resourceAuthority?.allowRegion ?? (() => false),
    allowCountry: options.resourceAuthority?.allowCountry ?? (() => false),
    allowDataType: options.resourceAuthority?.allowDataType ?? (() => false),
    allowCatalogRevision: options.resourceAuthority?.allowCatalogRevision ?? (() => false),
    allowUpdateJobId: options.resourceAuthority?.allowUpdateJobId ?? (() => false),
    allowExtension: () => false,
    allowIntegration: (integrationId) => integrations.has(integrationId),
    allowTrustedRevision: () => false,
  };
}

function requiresTrustedSource(operation: OpsOperation): boolean {
  switch (operation.kind) {
    case "motis.primary.promote":
    case "feedProxy.validateAndReload":
    case "extension.repository.inspect":
    case "extension.install":
    case "extension.update":
    case "extension.remove":
    case "stack.render":
    case "serviceSelection.apply":
    case "serviceConfig.apply":
    case "integrationConfig.apply":
    case "vault.apply":
      return true;
    default:
      return false;
  }
}

function claimedResourcePolicy(
  ordinary: OpsResourcePolicy,
  operation: OpsOperation,
): OpsResourcePolicy {
  const revisions = new Set<string>();
  const operationFields = operation as OpsOperation &
    Partial<Record<"updateJobId" | "catalogEntryId" | "catalogRevisionId" | "revisionId", string>>;
  for (const key of ["updateJobId", "catalogEntryId", "catalogRevisionId", "revisionId"] as const) {
    const value = operationFields[key];
    if (typeof value === "string") revisions.add(value);
  }
  return {
    ...ordinary,
    allowBackup: (kind, id) =>
      ((operation.kind === "backup.create" ||
        operation.kind === "backup.restore" ||
        operation.kind === "backup.delete") &&
        kind === operation.kind &&
        id === operation.backupId) ||
      (operation.kind === "system.update" && kind === "backup.create" && id === operation.backupId),
    allowPreparedRun: (id) =>
      operation.kind === "motis.primary.promote" && id === operation.preparedRunId,
    allowCandidate: (id) =>
      operation.kind === "feedProxy.validateAndReload" && id === operation.candidateId,
    allowRelease: (kind, id) =>
      (operation.kind === "release.pull" ||
        operation.kind === "release.apply" ||
        operation.kind === "appApi.replace" ||
        operation.kind === "system.update") &&
      kind === operation.kind &&
      id === operation.releaseId,
    allowRegion: (kind, id) =>
      "regionId" in operation &&
      operation.regionId !== undefined &&
      kind === operation.kind &&
      id === operation.regionId,
    allowCountry: (kind, id) =>
      operation.kind === "data.update" &&
      kind === operation.kind &&
      (operation.countryCodes ?? []).includes(id),
    allowDataType: (id) => operation.kind === "data.clean" && id === operation.dataTypeId,
    allowCatalogRevision: (kind, id) =>
      operation.kind === "data.generateApiKeys" &&
      kind === operation.kind &&
      id === operation.catalogRevisionId,
    allowUpdateJobId: (id) => operation.kind === "appApi.replace" && id === operation.updateJobId,
    allowExtension: (kind, id) =>
      (operation.kind === "extension.install" ||
        operation.kind === "extension.update" ||
        operation.kind === "extension.remove") &&
      kind === operation.kind &&
      id === operation.extensionId,
    allowTrustedRevision: (kind, id) => kind === operation.kind && revisions.has(id),
  };
}

function registryPreflightPolicy(ordinary: OpsResourcePolicy): OpsResourcePolicy {
  return {
    ...ordinary,
    allowBackup: () => true,
    allowPreparedRun: () => true,
    allowCandidate: () => true,
    allowRelease: () => true,
    allowRegion: () => true,
    allowDataType: () => true,
    allowCatalogRevision: () => true,
    allowUpdateJobId: () => true,
    allowExtension: () => true,
    allowTrustedRevision: () => true,
  };
}

function immutableClaim(
  operation: OpsOperation,
  fingerprint: string,
  source: OpsTrustedClaim["source"],
  capability: OpsTrustedClaim["capability"] = { revisionId: "registry-v1", values: {} },
  admission?: OpsTrustedClaim["admission"],
): OpsTrustedClaim {
  const deepFreeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  };
  const snapshot = structuredClone(operation);
  const capabilitySnapshot = structuredClone(capability);
  deepFreeze(snapshot);
  deepFreeze(capabilitySnapshot);
  return Object.freeze({
    fingerprint,
    operation: snapshot,
    source,
    capability: capabilitySnapshot,
    ...(admission ? { admission } : {}),
  });
}

export function createPolicyResourceClaimer(policy: OpsResourcePolicy): OpsResourceClaimer {
  return {
    claim: async (operation, fingerprint) =>
      (await authorizeOpsResources(operation, policy))
        ? immutableClaim(operation, fingerprint, "registry")
        : null,
  };
}

export function createRegistryResourceClaimer(options: {
  serviceIds: Iterable<string>;
  enabledServiceIds?: () => ReadonlySet<string>;
  integrationIds: Iterable<string>;
  trustedData: TrustedOpsDataSource;
  registryRevision?: string;
  resourceAuthority?: Pick<
    OpsResourcePolicy,
    | "allowBackup"
    | "allowRelease"
    | "allowRegion"
    | "allowCountry"
    | "allowDataType"
    | "allowCatalogRevision"
    | "allowUpdateJobId"
  >;
}): OpsResourceClaimer {
  const policy = createRegistryResourcePolicy(options);
  return {
    claim: async (operation, fingerprint, signal, owner) => {
      if (signal.aborted) throw signal.reason;
      if (!requiresTrustedSource(operation)) {
        return (await authorizeOpsResources(operation, policy))
          ? immutableClaim(
              operation,
              fingerprint,
              "registry",
              options.registryRevision
                ? { revisionId: options.registryRevision, values: {} }
                : undefined,
            )
          : null;
      }
      if (!(await authorizeOpsResources(operation, registryPreflightPolicy(policy)))) {
        return null;
      }
      if (signal.aborted) return null;
      const resolved = await options.trustedData.claim(operation, fingerprint, signal, owner);
      if (!resolved) return null;
      const capability = "capability" in resolved ? resolved.capability : resolved;
      const admission = "capability" in resolved ? resolved.admission : undefined;
      const rejectResolved = async () => {
        await admission?.rollback().catch(() => undefined);
        return null;
      };
      if (signal.aborted) return rejectResolved();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(capability.revisionId)) {
        return rejectResolved();
      }
      if (
        !capability.values ||
        typeof capability.values !== "object" ||
        Array.isArray(capability.values) ||
        Object.keys(capability.values).length > 64 ||
        Object.entries(capability.values).some(
          ([key, value]) =>
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) ||
            (value !== null && !["string", "number", "boolean"].includes(typeof value)) ||
            (typeof value === "number" && !Number.isFinite(value)),
        ) ||
        Buffer.byteLength(JSON.stringify(capability), "utf8") > 512 * 1024
      ) {
        return rejectResolved();
      }
      if (!(await authorizeOpsResources(operation, claimedResourcePolicy(policy, operation)))) {
        return rejectResolved();
      }
      return immutableClaim(operation, fingerprint, "trusted-data", capability, admission);
    },
  };
}

export function createProductionRegistryResourceClaimer<
  Service extends { serviceId: string; enabled: boolean; isBuiltIn: boolean },
>(options: {
  services: Iterable<Service>;
  integrationIds: Iterable<string>;
  trustedData: TrustedOpsDataSource;
  resourceAuthority?: Pick<
    OpsResourcePolicy,
    | "allowBackup"
    | "allowRelease"
    | "allowRegion"
    | "allowCountry"
    | "allowDataType"
    | "allowCatalogRevision"
    | "allowUpdateJobId"
  >;
  enabledServiceIds?: (services: readonly Service[]) => ReadonlySet<string>;
  loadAuthority?: () => Promise<{
    revisionId: string;
    services: readonly Service[];
    integrationIds: readonly string[];
  }>;
}): OpsResourceClaimer {
  const builtIns = [...options.services].filter((service) => service.isBuiltIn);
  const serviceIds = builtIns.map((service) => service.serviceId);
  const initialEnabled = new Set(
    builtIns.filter((service) => service.enabled).map((service) => service.serviceId),
  );
  if (!options.loadAuthority) {
    return createRegistryResourceClaimer({
      serviceIds,
      enabledServiceIds: () => options.enabledServiceIds?.(builtIns) ?? initialEnabled,
      integrationIds: options.integrationIds,
      trustedData: options.trustedData,
      resourceAuthority: options.resourceAuthority,
    });
  }
  return {
    claim: async (operation, fingerprint, signal, owner) => {
      const authority = await options.loadAuthority?.();
      if (!authority || signal.aborted) return null;
      const id = /^[a-z0-9][a-z0-9-]{0,63}$/;
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authority.revisionId) ||
        authority.services.length > 256 ||
        authority.integrationIds.length > 256 ||
        authority.services.some(
          (service) =>
            !id.test(service.serviceId) ||
            typeof service.enabled !== "boolean" ||
            typeof service.isBuiltIn !== "boolean",
        ) ||
        authority.integrationIds.some((integrationId) => !id.test(integrationId)) ||
        new Set(authority.services.map((service) => service.serviceId)).size !==
          authority.services.length ||
        new Set(authority.integrationIds).size !== authority.integrationIds.length
      ) {
        return null;
      }
      const trustedData: TrustedOpsDataSource = {
        claim: async (...args) => {
          const resolved = await options.trustedData.claim(...args);
          if (!resolved) return null;
          const capability = "capability" in resolved ? resolved.capability : resolved;
          if (capability.values.authorityRevision !== undefined) {
            if ("capability" in resolved) {
              await resolved.admission.rollback().catch(() => undefined);
            }
            return null;
          }
          const bound = {
            ...capability,
            values: { ...capability.values, authorityRevision: authority.revisionId },
          };
          return "capability" in resolved
            ? { capability: bound, admission: resolved.admission }
            : bound;
        },
      };
      return createRegistryResourceClaimer({
        serviceIds: authority.services.map((service) => service.serviceId),
        enabledServiceIds: () => options.enabledServiceIds?.(authority.services) ?? initialEnabled,
        integrationIds: authority.integrationIds,
        trustedData,
        registryRevision: authority.revisionId,
        resourceAuthority: options.resourceAuthority,
      }).claim(operation, fingerprint, signal, owner);
    },
  };
}
