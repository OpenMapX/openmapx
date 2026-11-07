import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContributorResolver } from "./useContributorResolver";

vi.mock("@openmapx/integration-framework/react", () => {
  const dataSources = [
    {
      sourceId: "firms",
      name: "NASA FIRMS",
      url: "https://firms.modaps.eosdis.nasa.gov/",
      licensing: licensingFromDeclaration("U.S. Public Domain", undefined, "NASA FIRMS"),
      providerCountry: "US",
      providerPrivacyUrl: "https://www.nasa.gov/privacy/",
    },
  ];
  return {
    useIntegrationRegistry: () => ({
      findDataSource: (sourceId: string) =>
        dataSources.find((source) => source.sourceId === sourceId),
    }),
  };
});

describe("useContributorResolver", () => {
  afterEach(() => cleanup());

  it("captures explicit sources without domain expansion and honors empty snapshots", () => {
    const { result } = renderHook(() => useContributorResolver());
    const captured = result.current({ sourceIds: ["firms", "missing"] });
    expect(captured.map((receipt) => receipt.sourceId)).toEqual(["firms"]);
    expect(result.current({ contributors: [], sourceIds: ["firms"] })).toEqual([]);
    expect(
      result.current({
        contributors: [{ sourceId: "old", name: "Captured" }],
        sourceIds: ["firms"],
      }),
    ).toEqual([{ sourceId: "old", name: "Captured" }]);
    expect(result.current({})).toEqual([]);
  });
});
