import type { SearchSuggestion, SearchSuggestionProviderResult } from "@openmapx/core";
import type { SearchSuggestionProvider } from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { createSearchSuggestionsOrchestrator } from "../orchestrator.js";

function suggestion(
  provider: string,
  kind: SearchSuggestion["searchMatch"]["kind"],
  value: string,
): SearchSuggestion {
  return {
    id: `${provider}:${value}`,
    label: `${provider} ${value} place`,
    coordinates: [8 + provider.length / 100, 50],
    type: "poi",
    searchMatch: { kind, value, normalized: value.toLowerCase() },
    importance: 0.5,
    provider,
  };
}

function provider(id: string, result: SearchSuggestionProviderResult): SearchSuggestionProvider {
  return { id, searchSuggestions: vi.fn().mockResolvedValue(result) };
}

function context(providers: SearchSuggestionProvider[]) {
  const ctx = createMockIntegrationContext();
  ctx.getIntegrationsByDomain = () =>
    providers.map((item) => ({
      id: item.id,
      manifest: {} as never,
      config: {},
      directory: "",
      isBuiltIn: true,
      enabled: true,
      providers: new Map([["search-suggestions", [item]]]),
      strings: {},
      shutdownHandlers: [],
    }));
  return ctx;
}

describe("search suggestion fan-out", () => {
  it("ranks authoritative, alias, then generated matches", async () => {
    const rows = [
      suggestion("generated", "generated_acronym", "FRA"),
      suggestion("alias", "explicit_alias", "FRA"),
      suggestion("airport", "authoritative_code", "FRA"),
    ];
    const ctx = context(
      rows.map((row) =>
        provider(row.provider, {
          suggestions: [row],
          attributions: [{ sourceId: row.provider, name: row.provider }],
          freshnessSeconds: 300,
        }),
      ),
    );

    const result = await createSearchSuggestionsOrchestrator(ctx).search({
      query: "FRA",
      lang: "en",
      limit: 8,
    });

    expect(result.suggestions.map((row) => row.searchMatch.kind)).toEqual([
      "authoritative_code",
      "explicit_alias",
      "generated_acronym",
    ]);
    expect(result.partial).toBe(false);
  });

  it("returns successful rows and partial=true after one provider fails", async () => {
    const good = provider("good", {
      suggestions: [suggestion("good", "authoritative_code", "FRA")],
      attributions: [{ sourceId: "good", name: "Good" }],
      freshnessSeconds: 300,
    });
    const bad: SearchSuggestionProvider = {
      id: "bad",
      searchSuggestions: vi.fn().mockRejectedValue(new Error("upstream unavailable")),
    };

    const result = await createSearchSuggestionsOrchestrator(context([good, bad])).search({
      query: "FRA",
      lang: "en",
      limit: 8,
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.partial).toBe(true);
    expect(result.attributions).toEqual([{ sourceId: "good", name: "Good" }]);
  });

  it("does not call policy-disallowed integrations", async () => {
    const blocked = provider("blocked", {
      suggestions: [],
      attributions: [],
      freshnessSeconds: 300,
    });
    const ctx = context([blocked]);
    ctx.getDisallowedIntegrationIds = async () => new Set(["blocked"]);

    const result = await createSearchSuggestionsOrchestrator(ctx).search({
      query: "FRA",
      lang: "en",
      limit: 8,
    });

    expect(blocked.searchSuggestions).not.toHaveBeenCalled();
    expect(result).toEqual({ suggestions: [], attributions: [], partial: false });
  });
});
