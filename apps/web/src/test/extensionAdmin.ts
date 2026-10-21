import type {
  AdminExtensionCatalogEntry,
  AdminExtensionInstallPreview,
  AdminInstalledExtension,
} from "@openmapx/core/api-contracts";
export const rating = {
  score: 4,
  requiresBuiltIn: false,
  hostPorts: 1,
  secretCount: 2,
  deploymentVariables: ["APP_MODE"],
  factors: ["Publishes a host port"],
};
export function catalogEntry(
  overrides: Partial<AdminExtensionCatalogEntry> = {},
): AdminExtensionCatalogEntry {
  return {
    id: "demo",
    name: "Demo extension",
    trust: "verified",
    components: { services: 1, integrations: 1 },
    compatible: true,
    platformVersion: "1",
    installed: false,
    installedVersion: null,
    hasUpdate: false,
    removed: null,
    critical: null,
    status: "verified",
    ...overrides,
  };
}
export function preview(
  overrides: Partial<AdminExtensionInstallPreview> = {},
): AdminExtensionInstallPreview {
  return {
    extension: { id: "demo", name: "Demo extension", version: "2" },
    sourceTrust: "community",
    services: [
      {
        id: "service-demo",
        name: "Demo service",
        version: "2",
        repositoryCommit: "a".repeat(40),
        hostPorts: [
          { host: 8080, container: 80, protocol: "tcp", bindAddress: "127.0.0.1" },
          { host: 5353, container: 53, protocol: "udp", bindAddress: "::" },
        ],
        securityRating: rating,
      },
    ],
    requiresHostPortConfirmation: true,
    confirmation: "b".repeat(64),
    ...overrides,
  };
}
export function installed(
  overrides: Partial<AdminInstalledExtension> = {},
): AdminInstalledExtension {
  return {
    id: "demo",
    name: "Demo extension",
    sourceTrust: "community",
    installedVersion: "1",
    sourceUrl: null,
    installedAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    components: [
      { kind: "service", componentId: "service-demo", enabled: true, securityRating: rating },
    ],
    hasUpdate: true,
    latestVersion: "2",
    ...overrides,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
