import { serviceAdminOperations } from "@openmapx/core/api-contracts";
import { expect, it, vi } from "vitest";
import { generateDocument } from "../document";

// Independent approved inventory: dropping a registry entry must fail too.
const inventory = [
  ["pullAdminServiceImages", "POST", "/services/images/pull"],
  ["clearAdminReleaseSelection", "POST", "/system/release/clear"],
  ["previewAdminBackupPrune", "POST", "/services/backups/prune/preview"],
  ["pruneAdminServiceBackups", "POST", "/services/backups/prune"],
  ["listAdminCacheNamespaces", "GET", "/cache"],
  ["clearAdminCache", "POST", "/cache/clear"],
  ["getAdminArtifactTransferCapabilities", "GET", "/artifact-transfers/capabilities"],
  ["exportAdminArtifactTransfer", "POST", "/artifact-transfers/exports"],
  ["previewAdminArtifactImport", "POST", "/artifact-transfers/{stageId}/preview-import"],
  ["importAdminArtifactTransfer", "POST", "/artifact-transfers/{stageId}/import"],
  ["validateAdminArtifactTransfer", "POST", "/artifact-transfers/{stageId}/validate"],
  ["listAdminServicePresets", "GET", "/services/presets"],
  ["renderAdminComposeConfiguration", "POST", "/compose/render"],
  ["listAdminArtifactTransfers", "GET", "/artifact-transfers"],
  ["createAdminArtifactTransfer", "POST", "/artifact-transfers"],
  ["getAdminArtifactTransfer", "GET", "/artifact-transfers/{stageId}"],
  ["deleteAdminArtifactTransfer", "DELETE", "/artifact-transfers/{stageId}"],
  ["uploadAdminArtifactTransferContent", "PUT", "/artifact-transfers/{stageId}/content"],
  ["downloadAdminArtifactTransferContent", "GET", "/artifact-transfers/{stageId}/content"],
  ["getAdminPlatformConfiguration", "GET", "/platform/configuration"],
  ["previewAdminPlatformConfiguration", "POST", "/platform/configuration/preview"],
  ["applyAdminPlatformConfiguration", "POST", "/platform/configuration/apply"],

  ["listAdminServices", "GET", "/services"],
  ["getAdminService", "GET", "/services/{id}"],
  ["getAdminServiceConfig", "GET", "/services/{id}/config"],
  ["updateAdminServiceConfig", "POST", "/services/{id}/config"],
  ["getAdminServiceCredentials", "GET", "/services/{id}/credentials"],
  ["setAdminServiceCredential", "PUT", "/services/{id}/credentials/{key}"],
  ["deleteAdminServiceCredential", "DELETE", "/services/{id}/credentials/{key}"],
  ["streamAdminServiceLogs", "GET", "/services/{id}/logs"],
  ["runAdminServiceAction", "POST", "/services/{id}/action"],
  ["runAdminServicesBulkAction", "POST", "/services/bulk-action"],
  ["checkAdminServices", "POST", "/services/check"],
  ["getAdminServiceData", "GET", "/services/data"],
  ["getAdminServiceSelection", "GET", "/services/selection"],
  ["setAdminServiceSelection", "PUT", "/services/selection"],
  ["listAdminServiceBackups", "GET", "/services/backups"],
  ["createAdminServiceBackup", "POST", "/services/backups"],
  ["restoreAdminServiceBackup", "POST", "/services/backups/{name}/restore"],
  ["deleteAdminServiceBackup", "DELETE", "/services/backups/{name}"],
  ["getAdminDeployment", "GET", "/deployment"],
  ["getAdminComposePreview", "GET", "/compose/preview"],
  ["startAdminCompose", "POST", "/compose/up"],
  ["stopAdminCompose", "POST", "/compose/down"],
  ["listAdminOperations", "GET", "/operations"],
  ["previewAdminOperation", "POST", "/operations/{id}/preview"],
  ["runAdminOperation", "POST", "/operations/{id}/run"],
  ["getAdminSharedMobility", "GET", "/shared-mobility"],
  ["rollbackAdminSharedMobility", "POST", "/shared-mobility/{category}/rollback"],
  ["getAdminDawarich", "GET", "/dawarich"],
  ["provisionAdminDawarich", "POST", "/dawarich/provision"],
  ["rotateAdminDawarichOidcSecret", "POST", "/dawarich/rotate-oidc-secret"],
] as const;

it("collects exactly 52 actual service producers with complete statuses, media, headers and auth", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Network denied"));
  try {
    const document = JSON.parse(await generateDocument());
    const tagged = Object.values(document.paths)
      .flatMap((item) => Object.values(item as object))
      .filter((value) => (value as { tags?: string[] }).tags?.includes("service-admin"));
    expect(tagged).toHaveLength(52);
    expect(Object.keys(serviceAdminOperations).sort()).toEqual(inventory.map(([id]) => id).sort());
    for (const [id, method, path] of inventory) {
      const contract = serviceAdminOperations[id];
      const actual = document.paths[`/api/admin${path}`][method.toLowerCase()];
      expect(actual.operationId).toBe(id);
      expect(actual["x-openmapx-auth"]).toBe("admin");
      expect(actual.tags).toContain("service-admin");
      expect(Object.keys(actual.responses).sort()).toEqual(Object.keys(contract.responses).sort());
      for (const [status, response] of Object.entries(contract.responses)) {
        const media =
          response.kind === "json"
            ? "application/json"
            : "mediaType" in response
              ? response.mediaType
              : undefined;
        expect(Object.keys(actual.responses[status].content ?? {})).toEqual(media ? [media] : []);
      }
      if (path.startsWith("/artifact-transfers")) {
        // Retained quota/attempt/concurrency denials have no truthful retry timer.
        expect(actual.responses["429"].headers).toBeUndefined();
        expect(actual.responses["429"].content["application/json"].schema).toEqual({
          anyOf: [
            {
              type: "object",
              properties: {
                error: { type: "string" },
                ok: { type: "boolean", enum: [false] },
                message: { type: "string" },
                jobId: { type: "string" },
              },
              required: ["error"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                statusCode: { type: "integer", minimum: 400, maximum: 599 },
                error: { type: "string" },
                message: { type: "string" },
                code: { type: "string" },
              },
              required: ["statusCode", "error", "message"],
              additionalProperties: false,
            },
          ],
        });
      } else {
        expect(actual.responses["429"].headers).toHaveProperty("retry-after");
      }
    }
    for (const path of ["/services/{id}/logs", "/compose/up"]) {
      const actual = document.paths[`/api/admin${path}`][path.endsWith("logs") ? "get" : "post"];
      expect(actual.parameters).toContainEqual(
        expect.objectContaining({ in: "header", name: "idempotency-key", required: true }),
      );
    }
    const bytes = document.paths["/api/admin/artifact-transfers/{stageId}/content"];
    expect(bytes.put.requestBody).toEqual({
      required: true,
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    });
    expect(bytes.get.responses[200].content).toEqual({
      "application/octet-stream": { schema: { type: "string", format: "binary" } },
    });
    expect(bytes.get.responses[200].headers).toEqual({
      "content-type": { schema: { type: "string", const: "application/octet-stream" } },
      "content-length": { schema: { type: "string", pattern: "^(0|[1-9][0-9]*)$" } },
      "content-disposition": {
        schema: { type: "string", const: 'attachment; filename="openmapx-artifact.tar"' },
      },
      "x-artifact-sha256": { schema: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      "cache-control": { schema: { type: "string", const: "no-store" } },
      "x-content-type-options": { schema: { type: "string", const: "nosniff" } },
    });
    expect(document.paths["/api/admin/compose/down"].post.responses).not.toHaveProperty("200");
    expect(document.paths["/api/admin/services/backups"].post.requestBody.required).toBe(false);
    expect(document.paths["/api/admin/services/selection"].put.requestBody.required).toBe(true);
  } finally {
    network.mockRestore();
  }
}, 30000);
