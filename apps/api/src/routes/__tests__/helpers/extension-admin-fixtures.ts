import type {
  AdminExtensionInstallPreview,
  AdminExtensionSecurityRating,
} from "@openmapx/core/api-contracts";

export const extensionCatalogFixture = {
  id: "sample/ext ?#",
  name: "Synthetic extension",
  version: "2.0",
  summary: "Fixture",
  description: "Full catalog",
  author: "Synthetic",
  homepage: "https://example.test",
  icon: "box",
  screenshots: ["https://example.test/a.png"],
  categories: ["routing"],
  tags: ["test"],
  minPlatform: "1.0",
  lastUpdated: "2026-10-20",
  featured: true,
  trust: "community" as const,
  manifest: "https://example.test/extension.json",
  manifestSha256: "a".repeat(64),
  services: [
    {
      repo: "https://example.test/repo",
      service: "synthetic",
      ref: "a".repeat(40),
      unfamiliar: { array: [null, { keep: true }] },
    },
  ],
  integrations: [
    {
      artifact: "https://example.test/integration.tar.gz",
      id: "synthetic",
      sha256: "b".repeat(64),
      unfamiliar: { nested: [1, false] },
    },
  ],
  unfamiliar: {
    nested: [
      null,
      { schema: { type: "object", properties: { value: { type: "string", examples: ["kept"] } } } },
    ],
  },
};
export const extensionManifestFixture = {
  id: extensionCatalogFixture.id,
  name: extensionCatalogFixture.name,
  version: "2.0",
  services: extensionCatalogFixture.services,
  integrations: extensionCatalogFixture.integrations,
};
export const extensionServiceFixture = {
  id: "synthetic",
  name: "Synthetic service",
  version: "1.0.0",
  description: "Fixture",
  quality: "community" as const,
  container: {
    image: "example/service",
    tag: "1",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal deployment variable is fixture data.
    environment: { LABEL: "${SYNTHETIC_LABEL}" },
  },
  exposure: {
    hostPorts: [{ host: 8080, container: 80, protocol: "tcp" as const, bindAddress: "127.0.0.1" }],
  },
  configSchema: {
    type: "object",
    properties: { token: { type: "string", "x-openmapx-secret": true } },
  },
};
// Hand-derived from the service fixture: base 5 - one host port - deployment variables.
export const extensionRatingFixture: AdminExtensionSecurityRating = {
  score: 2,
  requiresBuiltIn: false,
  hostPorts: 1,
  secretCount: 1,
  deploymentVariables: ["SYNTHETIC_LABEL"],
  factors: [
    "-1 publishes 1 host port(s)",
    "-2 reads 1 deployment environment variable(s): SYNTHETIC_LABEL",
  ],
};
export const extensionInstalledFixture = {
  id: extensionCatalogFixture.id,
  name: extensionCatalogFixture.name,
  sourceTrust: "community" as const,
  installedVersion: "1.0",
  sourceUrl: null,
  installedAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
  components: [
    { kind: "service" as const, componentId: "synthetic" },
    { kind: "integration" as const, componentId: "synthetic" },
  ],
  manifest: { privateDatabaseField: true },
};
export const extensionSourcesFixture = [
  { url: "https://example.test/default", label: "Default", isDefault: true },
  { url: " https://example.test/custom ", label: " Custom ", isDefault: false },
];
export const extensionPreviewFixture: AdminExtensionInstallPreview = {
  extension: { id: extensionCatalogFixture.id, name: extensionCatalogFixture.name, version: "2.0" },
  sourceTrust: "community",
  services: [
    {
      id: "synthetic",
      name: "Synthetic service",
      version: "1.0",
      repositoryCommit: "a".repeat(40),
      hostPorts: [
        { host: 8080, container: 80, protocol: "tcp", bindAddress: "127.0.0.1" },
        { host: 5353, container: 53, protocol: "udp", bindAddress: "::1" },
      ],
      securityRating: {
        score: 3,
        requiresBuiltIn: false,
        hostPorts: 2,
        secretCount: 1,
        deploymentVariables: ["SYNTHETIC_LABEL"],
        factors: ["Synthetic factor"],
      },
    },
    {
      id: "second",
      name: "Second service",
      version: "2",
      repositoryCommit: "c".repeat(40),
      hostPorts: [],
      securityRating: {
        score: 7,
        requiresBuiltIn: false,
        hostPorts: 0,
        secretCount: 0,
        deploymentVariables: [],
        factors: ["+1 no host ports published (inter-container only)"],
      },
    },
  ],
  requiresHostPortConfirmation: true,
  confirmation: "b".repeat(64),
};

// Independent method/path/operation inventory: never derive expectations from the registry.
export const extensionOperationInventory = [
  ["GET", "/catalog", "listAdminExtensionCatalog", 200],
  ["GET", "/catalog/:id", "getAdminExtensionCatalogEntry", 200],
  ["GET", "/installed", "listAdminInstalledExtensions", 200],
  ["POST", "/install-preview", "previewAdminExtensionInstall", 200],
  ["POST", "/install", "installAdminExtension", 202],
  ["POST", "/update/:id", "updateAdminExtension", 202],
  ["DELETE", "/:id", "removeAdminExtension", 202],
  ["GET", "/sources", "listAdminExtensionSources", 200],
  ["POST", "/sources", "addAdminExtensionSource", 200],
  ["DELETE", "/sources", "removeAdminExtensionSource", 200],
  ["POST", "/refresh-catalog", "refreshAdminExtensionCatalog", 200],
] as const;
