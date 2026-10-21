import { serviceAdminOperations } from "@openmapx/core/api-contracts";
import { expect, it, vi } from "vitest";
import { generateDocument } from "../document";

// Independent approved inventory: dropping a registry entry must fail too.
const inventory = [
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

it("collects exactly 30 actual service producers with complete statuses, media, headers and auth", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Network denied"));
  try {
    const document = JSON.parse(await generateDocument());
    const tagged = Object.values(document.paths)
      .flatMap((item) => Object.values(item as object))
      .filter((value) => (value as { tags?: string[] }).tags?.includes("service-admin"));
    expect(tagged).toHaveLength(30);
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
      expect(actual.responses["429"].headers).toHaveProperty("retry-after");
    }
    for (const path of ["/services/{id}/logs", "/compose/up"]) {
      const actual = document.paths[`/api/admin${path}`][path.endsWith("logs") ? "get" : "post"];
      expect(actual.parameters).toContainEqual(
        expect.objectContaining({ in: "header", name: "idempotency-key", required: true }),
      );
    }
    expect(document.paths["/api/admin/compose/down"].post.responses).not.toHaveProperty("200");
    expect(document.paths["/api/admin/services/backups"].post.requestBody.required).toBe(false);
    expect(document.paths["/api/admin/services/selection"].put.requestBody.required).toBe(true);
  } finally {
    network.mockRestore();
  }
}, 30000);
