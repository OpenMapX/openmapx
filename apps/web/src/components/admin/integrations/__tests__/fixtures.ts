import type { AdminIntegrationDetail, AdminIntegrationSummary } from "@openmapx/core/api-contracts";

export const summary: AdminIntegrationSummary = {
  id: "demo",
  name: "Demo",
  domains: ["geocoding"],
  quality: "built-in",
  isBuiltIn: true,
  blockedCode: false,
  enabled: true,
  configured: true,
  hasHealthCheck: false,
  health: null,
  dependencies: [],
  requires: [],
  infrastructure: null,
};
export const detail: AdminIntegrationDetail = {
  ...summary,
  manifest: {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    domains: ["geocoding"],
    customMetadata: { retained: ["full", 1] },
  },
  resolvedConfig: {},
  dependencyStatus: [],
  secretsConfigured: true,
  credentialStatus: [
    {
      key: "token",
      title: "Token",
      source: "config.json",
      updatedAt: "2026-10-20T09:00:00.000Z",
      updatedBy: "admin",
    },
  ],
};
