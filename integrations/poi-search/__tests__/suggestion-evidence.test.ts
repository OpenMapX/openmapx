import type { BrandSuggestResponse, PresetMatch } from "@openmapx/core";
import { brandSuggestionRows, presetSuggestionRows, rankAutocompleteRows } from "@openmapx/core";
import type { IntegrationContext, RouteHandler } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index";

async function response(path: string, query: Record<string, string>): Promise<unknown> {
  const routes = new Map<string, RouteHandler>();
  setup({
    registerRoute: (_method: string, route: string, handler: RouteHandler) =>
      routes.set(route, handler),
    getIntegrationsByDomain: () => [],
    getRequiredService: () => ({}),
    cache: {
      withCache: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IntegrationContext);
  let payload: unknown;
  const reply = {
    header: () => reply,
    status: () => reply,
    send: (data: unknown) => {
      payload = data;
      return reply;
    },
  };
  const handler = routes.get(path);
  if (!handler) throw new Error("missing suggestion route");
  await handler({ query, params: {} } as never, reply as never);
  return JSON.parse(JSON.stringify(payload));
}

describe("catalog evidence survives route serialization and autocomplete ranking", () => {
  it.each([
    ["Kentucky Fried Chicken", "Q524757"],
    ["Роснефть", "Q1141123"],
  ])("keeps the canonical brand for alias %s", async (query, qid) => {
    const body = (await response("/brand-suggest", { q: query })) as BrandSuggestResponse;
    expect(body.matches.some((match) => match.qid === qid)).toBe(true);
    const rows = rankAutocompleteRows({ brands: brandSuggestionRows(body.matches, "") }, { query });
    expect(rows.some((row) => row.id === `brand:${qid}`)).toBe(true);
    expect(rows.find((row) => row.id === `brand:${qid}`)?.brand?.qid).toBe(qid);
  });

  it.each([
    ["eisdiele", "de"],
    ["gelato", "en"],
  ])("keeps the ice cream category for %s", async (query, lang) => {
    const body = (await response("/preset-suggest", { q: query, lang })) as {
      matches: PresetMatch[];
    };
    expect(body.matches.some((match) => match.id === "amenity/ice_cream")).toBe(true);
    const rows = rankAutocompleteRows(
      { presets: presetSuggestionRows(body.matches, "") },
      { query },
    );
    expect(rows.some((row) => row.id === "category-preset:amenity/ice_cream")).toBe(true);
  });
});
