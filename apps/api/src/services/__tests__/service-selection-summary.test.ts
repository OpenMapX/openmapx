import { services } from "@openmapx/core/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readDesiredSelection = vi.fn();
vi.mock("../desired-selection", () => ({
  readDesiredSelection: () => readDesiredSelection(),
}));

const { getServiceSelectionSummary, validateServiceSelectionForWrite } = await import(
  "../admin-cli"
);

function registry() {
  const loaded = new services.ServiceRegistry({ rootDir: "/unused" });
  const service = (id: string, dependsOn?: string) => ({
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in" as const,
      container: {
        image: `t/${id}`,
        tag: "1",
        ...(dependsOn
          ? { dependsOn: [{ service: dependsOn, condition: "service_started" as const }] }
          : {}),
      },
    },
    directory: `/services/${id}`,
    isBuiltIn: true,
    enabled: false,
  });
  vi.spyOn(loaded, "list").mockReturnValue([service("valhalla", "postgis"), service("postgis")]);
  return loaded;
}

describe("service selection summary", () => {
  beforeEach(() => readDesiredSelection.mockReset());

  it("reports the selection the ops-agent reads from the deployment, as the CLI does", async () => {
    readDesiredSelection.mockResolvedValue({ source: "file", roots: ["valhalla"] });

    await expect(getServiceSelectionSummary(registry())).resolves.toMatchObject({
      source: "file",
      selectedRoots: ["valhalla"],
      effectiveIds: ["valhalla", "postgis"],
      envVarValue: null,
      selectionFilePath: "infra/docker/service-selection.json",
    });
  });

  it("leaves the selection to the operator's override while it is set", async () => {
    readDesiredSelection.mockResolvedValue({ source: "env", roots: ["postgis"] });

    await expect(getServiceSelectionSummary(registry())).resolves.toMatchObject({
      source: "env",
      envVarValue: "postgis",
    });
    await expect(validateServiceSelectionForWrite(registry(), ["valhalla"])).rejects.toThrow(
      /OPENMAPX_ENABLED_SERVICES is set/,
    );
  });

  it("accepts a selection of installed services when no override is set", async () => {
    readDesiredSelection.mockResolvedValue({ source: "default", roots: [] });

    await expect(validateServiceSelectionForWrite(registry(), ["valhalla"])).resolves.toMatchObject(
      { normalized: ["valhalla"], missingIds: [] },
    );
    await expect(validateServiceSelectionForWrite(registry(), ["missing"])).rejects.toThrow(
      /not installed: missing/,
    );
  });
});
