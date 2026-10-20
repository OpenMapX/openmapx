import { activityAdminOperations } from "@openmapx/core/api-contracts";
import { expect, it, vi } from "vitest";
import { generateDocument } from "../document";

it("collects exactly five actual Activity operations with complete media, status and admin auth", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Network denied");
  });
  try {
    const document = JSON.parse(await generateDocument());
    const tagged = Object.values(document.paths)
      .flatMap((item) => Object.values(item as object))
      .filter((value) => (value as { tags?: string[] }).tags?.includes("activity-admin"));
    expect(tagged).toHaveLength(5);
    for (const [id, contract] of Object.entries(activityAdminOperations)) {
      const actual =
        document.paths[contract.path.replace(/:([A-Za-z_$][\w$]*)/g, "{$1}")]?.[
          contract.method.toLowerCase()
        ];
      expect(actual.operationId, id).toBe(id);
      expect(actual["x-openmapx-auth"], id).toBe("admin");
      expect(Object.keys(actual.responses).sort(), id).toEqual(
        Object.keys(contract.responses).sort(),
      );
      for (const [status, response] of Object.entries(contract.responses)) {
        const media = response.kind === "stream" ? response.mediaType : "application/json";
        expect(Object.keys(actual.responses[status].content)).toEqual([media]);
      }
    }
    const parameters = document.paths["/api/admin/jobs"].get.parameters;
    for (const name of ["limit", "offset"]) {
      const parameter = parameters.find((entry: { name: string }) => entry.name === name);
      expect(parameter.required).toBe(false);
      expect(parameter.schema.type).toBe("integer");
      expect(parameter.schema.default).toBe(name === "limit" ? 50 : 0);
      expect(parameter.schema.minimum).toBe(name === "limit" ? 1 : 0);
    }
    expect(
      parameters.find((entry: { name: string }) => entry.name === "limit").schema.maximum,
    ).toBe(200);
    const source = document.paths["/api/admin/jobs/{id}"].get.parameters.find(
      (entry: { name: string }) => entry.name === "source",
    );
    expect(source.schema.enum).toEqual(["application", "data-manager"]);
    expect(
      document.tags.find((tag: { name: string }) => tag.name === "activity-admin").description,
    ).toContain("Activity");
  } finally {
    network.mockRestore();
  }
}, 30_000);
