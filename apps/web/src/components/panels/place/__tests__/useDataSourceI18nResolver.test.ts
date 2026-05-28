// @vitest-environment jsdom

import type { LocaleStrings } from "@openmapx/integration-framework/strings";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useLocale: () => "de",
}));

vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({
    get: (id: string) =>
      id === "parking"
        ? {
            id: "parking",
            strings: {
              de: { row: { freeSpaces: "Freie Plätze" } },
              en: { row: { freeSpaces: "Free Spaces" } },
            } satisfies LocaleStrings,
          }
        : undefined,
    getByDomain: () => [],
    findDataSource: () => undefined,
  }),
}));

vi.mock("@/lib/frameworkStringsContext", () => ({
  useFrameworkStrings: () =>
    ({
      de: { shared: { row: { source: "Quelle" } } },
      en: { shared: { row: { source: "Source" } } },
    }) satisfies LocaleStrings,
}));

import { useDataSourceI18nResolver } from "../useDataSourceI18nResolver.js";

describe("useDataSourceI18nResolver", () => {
  it("resolves an integration-scoped token via the matching integration", () => {
    const { result } = renderHook(() => useDataSourceI18nResolver("parking"));
    expect(result.current({ $t: "row.freeSpaces" })).toBe("Freie Plätze");
  });

  it("resolves a shared.* token via framework strings regardless of integration", () => {
    const { result } = renderHook(() => useDataSourceI18nResolver("parking"));
    expect(result.current({ $t: "shared.row.source" })).toBe("Quelle");
  });

  it("returns string passthrough values verbatim", () => {
    const { result } = renderHook(() => useDataSourceI18nResolver("parking"));
    expect(result.current("12/50")).toBe("12/50");
    expect(result.current(529)).toBe("529");
  });

  it("returns the key verbatim when no catalog yields a translation", () => {
    const { result } = renderHook(() => useDataSourceI18nResolver("parking"));
    expect(result.current({ $t: "row.completelyUnknown" })).toBe("row.completelyUnknown");
  });
});
