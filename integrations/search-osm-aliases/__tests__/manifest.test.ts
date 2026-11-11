import {
  type IntegrationManifest,
  resolveIntegrationContributors,
  validateManifest,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { expect, it } from "vitest";
import manifest from "../manifest.json";

it("credits the OpenStreetMap notice declared in the manifest", () => {
  expect(validateManifest(manifest).errors).toEqual([]);
  const ctx = createMockIntegrationContext({ manifest: manifest as IntegrationManifest });

  expect(resolveIntegrationContributors(ctx, ["openstreetmap"])).toEqual([
    expect.objectContaining({
      sourceId: "openstreetmap",
      attributionText: "© OpenStreetMap contributors",
    }),
  ]);
});
