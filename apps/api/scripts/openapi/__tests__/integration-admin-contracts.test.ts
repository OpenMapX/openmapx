import { integrationAdminOperations } from "@openmapx/core/api-contracts";
import { expect, it, vi } from "vitest";
import { generateDocument } from "../document";

it("collects exactly all 22 actual integration producers, complete statuses, headers and admin auth", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw Error("Network denied");
  });
  try {
    const document = JSON.parse(await generateDocument());
    const tagged = Object.values(document.paths)
      .flatMap((item) => Object.values(item as object))
      .filter((value) => (value as { tags?: string[] }).tags?.includes("integration-admin"));
    expect(tagged).toHaveLength(22);
    for (const [id, contract] of Object.entries(integrationAdminOperations)) {
      const actual =
        document.paths[contract.path.replace(/:([^/]+)/g, "{$1}")][contract.method.toLowerCase()];
      expect(actual.operationId).toBe(id);
      expect(actual["x-openmapx-auth"]).toBe("admin");
      expect(Object.keys(actual.responses).sort()).toEqual(Object.keys(contract.responses).sort());
      for (const status of Object.keys(contract.responses))
        expect(Object.keys(actual.responses[status].content)).toEqual(["application/json"]);
      expect(actual.responses["429"].headers).toHaveProperty("retry-after");
    }
    const hours = document.paths["/api/admin/integrations/{id}/health/history"].get.parameters.find(
      (p: { name: string }) => p.name === "hours",
    );
    expect(hours).toMatchObject({
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 168, default: 24 },
    });
    expect(document.paths["/api/admin/integrations/reload"].post.requestBody.required).toBe(false);
    expect(document.paths["/api/admin/integrations/import"].post.requestBody.required).toBe(true);
    expect(document.paths["/api/admin/integrations/import"].post.responses).toHaveProperty("409");
  } finally {
    network.mockRestore();
  }
}, 30000);
