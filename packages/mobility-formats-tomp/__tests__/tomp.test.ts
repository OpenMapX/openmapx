import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleTompOpenApiDocuments,
  dereferenceTompOpenApiDocument,
  generateTompSdk,
  listTompExternalRefs,
  listTompModules,
  listTompOperations,
  parseTompOpenApiDocument,
  resolveTompRef,
  validateTompOpenApiDocument,
} from "../tomp.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("TOMP helpers", () => {
  const tompCore = `openapi: 3.0.0
info:
  title: TOMP-API
  version: "2.0.0"
  x-modules:
    - core
paths:
  /collections/packages/items:
    get:
      operationId: getPackage
      summary: Get package details
      tags:
        - core
      security:
        - BearerAuth: []
      responses:
        "200":
          $ref: "#/components/responses/packageResponse"
components:
  parameters:
    packageId:
      name: packageId
      in: query
      schema:
        type: string
  responses:
    packageResponse:
      description: Package details
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer`;

  const tompOffers = `openapi: 3.1.0
info:
  title: TOMP Offers
  version: "2.0.0"
  x-modules:
    - offers
paths:
  /collections/offers/items:
    get:
      operationId: requestOffer
      summary: Get offer details
      tags:
        - offer
      parameters:
        - $ref: "TOMP-API-1-CORE.yaml#/components/parameters/packageId"
      responses:
        "200":
          $ref: "TOMP-API-1-CORE.yaml#/components/responses/packageResponse"
components:
  schemas:
    offerCollection:
      type: object`;

  it("parses, validates, bundles, dereferences, and codegens modular TOMP OpenAPI documents", async () => {
    const offersDocument = parseTompOpenApiDocument(tompOffers);
    const bundled = bundleTompOpenApiDocuments([
      {
        content: tompCore,
        fileName: "TOMP-API-1-CORE.yaml",
      },
      {
        content: tompOffers,
        fileName: "TOMP-API-2-OFFERS.yaml",
      },
    ]);
    const validation = await validateTompOpenApiDocument(bundled);
    const dereferenced = await dereferenceTompOpenApiDocument(bundled);
    const dir = mkdtempSync(join(tmpdir(), "openmapx-tomp-sdk-"));
    tempDirs.push(dir);

    expect(listTompModules(offersDocument)).toEqual(["offers"]);
    expect(listTompExternalRefs(offersDocument)).toEqual([
      "TOMP-API-1-CORE.yaml#/components/parameters/packageId",
      "TOMP-API-1-CORE.yaml#/components/responses/packageResponse",
    ]);
    expect(validation.valid).toBe(true);
    expect(bundled.openapi).toBe("3.1.0");
    expect(listTompModules(bundled)).toEqual(["core", "offers"]);
    expect(listTompExternalRefs(bundled)).toEqual([]);
    expect(resolveTompRef("#/components/responses/packageResponse", bundled)).toBeDefined();
    expect(listTompOperations(bundled).map((operation) => operation.operationId)).toEqual([
      "getPackage",
      "requestOffer",
    ]);
    expect(listTompExternalRefs(dereferenced)).toEqual([]);

    await generateTompSdk({
      document: bundled,
      outputPath: dir,
    });

    expect(readdirSync(dir).sort()).toEqual(
      expect.arrayContaining(["client.gen.ts", "index.ts", "sdk.gen.ts", "types.gen.ts"]),
    );
  });
});
