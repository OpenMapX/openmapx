import { dataManagerAdminOperations } from "@openmapx/core/api-contracts";
import { expect, it } from "vitest";
import { generateDocument } from "../document";

it("documents all 25 actual administration registrations with complete status contracts and auth", async () => {
  const document = JSON.parse(await generateDocument());
  const tagged = Object.values(document.paths)
    .flatMap((item) => Object.values(item as object))
    .filter((value) => (value as { tags?: string[] }).tags?.includes("data-manager-admin"));
  expect(tagged).toHaveLength(25);
  for (const [id, contract] of Object.entries(dataManagerAdminOperations)) {
    const path = contract.path.replace(/:([A-Za-z_$][\w$]*)/g, "{$1}");
    const actual = document.paths[path]?.[contract.method.toLowerCase()];
    expect(actual, id).toBeDefined();
    expect(actual.operationId, id).toBe(id);
    expect(actual["x-openmapx-auth"], id).toBe(contract.auth);
    expect(Object.keys(actual.responses).sort(), id).toEqual(
      Object.keys(contract.responses).sort(),
    );
    for (const response of Object.values(actual.responses)) {
      expect(response).toMatchObject({
        content: { "application/json": { schema: expect.any(Object) } },
      });
    }
  }
}, 30_000);
