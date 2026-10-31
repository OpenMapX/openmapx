import { readFile } from "node:fs/promises";
import { dataManagerOperations } from "@openmapx/core/data-manager-contracts";
import { expect, it } from "vitest";
import { DOCUMENT_PATH, generateDocument } from "../scripts/openapi/document.js";

it("exports every actual data-manager route with stable IDs, auth and payload contracts", async () => {
  const generated = await generateDocument();
  expect(generated).toBe(await readFile(DOCUMENT_PATH, "utf8"));
  const document = JSON.parse(generated);
  const operations = Object.values(document.paths).flatMap((path) => Object.values(path as object));
  expect(operations.map((value: { operationId: string }) => value.operationId).sort()).toEqual(
    Object.keys(dataManagerOperations).sort(),
  );

  for (const value of operations) {
    const operation = value as {
      operationId: keyof typeof dataManagerOperations;
      responses: object;
      security: unknown[];
      "x-openmapx-auth": string;
    };
    const contract = dataManagerOperations[operation.operationId];
    expect(contract).toBeDefined();
    expect(operation["x-openmapx-auth"]).toBe(contract.auth);
    expect(Object.keys(operation.responses).sort()).toEqual(Object.keys(contract.responses).sort());
    expect(operation.security.length > 0).toBe(contract.auth === "service");
  }
  expect(
    document.paths["/offline/packages/glyphs/{version}/{fontstack}/{range}.pbf"].head.operationId,
  ).toBe("headOfflineGlyph");
});

it("exports fixed coordinate tuples using the OpenAPI 3.1 JSON Schema dialect", async () => {
  const document = JSON.parse(await generateDocument());
  const legacy: unknown[] = [];
  const tuples: unknown[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (Array.isArray(node.items)) legacy.push(node);
    if (Array.isArray(node.prefixItems) && node.prefixItems.length === 4) tuples.push(node);
    for (const child of Object.values(node)) visit(child);
  }
  visit(document);
  expect(legacy).toHaveLength(0);
  expect(tuples.length).toBeGreaterThan(0);
});
