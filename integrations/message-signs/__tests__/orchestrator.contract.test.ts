import type { BoundingBox } from "@openmapx/core";
import type {
  IntegrationContext,
  MessageSign,
  MessageSignProvider,
} from "@openmapx/integration-framework";
import { describe, expect, test, vi } from "vitest";
import { createMessageSignDataSource } from "../data-source.js";

/** A box a map at zoom 12 shows over Binghamton. */
const BBOX: BoundingBox = { west: -75.95, south: 42.05, east: -75.75, north: 42.15 };

function sign(over: Partial<MessageSign> & Pick<MessageSign, "id">): MessageSign {
  return {
    name: `Sign ${over.id}`,
    type: "matrix",
    coordinates: [-75.8, 42.07],
    status: "in_service",
    pages: [["CRASH AHEAD"]],
    sources: ["src-a"],
    attributions: [{ sourceId: "src-a", name: "Source A" }],
    ...over,
  };
}

function provider(
  id: string,
  signs: MessageSign[] | Error,
  over: Partial<MessageSignProvider> = {},
): MessageSignProvider {
  return {
    id,
    searchSigns: vi.fn(async () => {
      if (signs instanceof Error) throw signs;
      return { signs };
    }),
    getSign: vi.fn(async (signId: string) =>
      signs instanceof Error ? null : (signs.find((s) => s.id === signId) ?? null),
    ),
    ...over,
  };
}

/** A context over `providers` under the `message-signs` domain. */
function ctxWith(
  providers: MessageSignProvider[],
  opts: { disallowed?: string[] } = {},
): IntegrationContext {
  const quiet = (): void => {};
  return {
    getIntegrationsByDomain: (domain: string) =>
      domain === "message-signs"
        ? providers.map((p) => ({
            id: p.id,
            providers: new Map<string, MessageSignProvider[]>([["message-signs", [p]]]),
          }))
        : [],
    getDisallowedSourceIds: opts.disallowed ? async () => new Set(opts.disallowed) : undefined,
    log: { warn: quiet, error: quiet, info: quiet, debug: quiet },
  } as unknown as IntegrationContext;
}

describe("message-signs data source", () => {
  test("merges providers, survives one failing, and passes a partial reason through", async () => {
    const a = provider("a", [sign({ id: "a:1" }), sign({ id: "a:2" })]);
    const source = createMessageSignDataSource(
      ctxWith([
        a,
        provider("b", new Error("upstream down")),
        provider("c", [], {
          searchSigns: vi.fn(async () => ({
            signs: [sign({ id: "c:1", sources: ["src-c"] })],
            partial: "area" as const,
          })),
        }),
      ]),
    );

    const result = await source.search(BBOX);

    expect(result.data.map((r) => r.id)).toEqual(["a:1", "a:2", "c:1"]);
    expect(result.partial).toBe("area");
    expect(a.searchSigns).toHaveBeenCalledWith([-75.95, 42.05, -75.75, 42.15], expect.any(Object));
    expect(source.id).toBe("message-signs");
    expect(source.attribution).toEqual([]);
  });

  test("keeps out a sign of a source the operator disallows", async () => {
    const source = createMessageSignDataSource(
      ctxWith([provider("a", [sign({ id: "a:1" }), sign({ id: "a:2", sources: ["src-x"] })])], {
        disallowed: ["src-x"],
      }),
    );
    expect((await source.search(BBOX)).data.map((r) => r.id)).toEqual(["a:1"]);
  });

  test("filters by what a sign is doing", async () => {
    const source = createMessageSignDataSource(
      ctxWith([
        provider("a", [
          sign({ id: "showing" }),
          sign({ id: "blank", status: "blank", pages: [] }),
          sign({ id: "fault", status: "fault", pages: [] }),
        ]),
      ]),
    );
    const blankOrFault = await source.search(BBOX, { status: ["blank", "fault"] });
    expect(blankOrFault.data.map((r) => r.id)).toEqual(["blank", "fault"]);
    expect((await source.getFilters())[0]).toMatchObject({ id: "status", label: "Status" });
  });

  test("answers a view wider than its zoom empty without asking a provider", async () => {
    const a = provider("a", [sign({ id: "a:1" })]);
    const source = createMessageSignDataSource(ctxWith([a]));
    const world = await source.search({ west: -180, south: -85, east: 180, north: 85 });
    expect(world.data).toEqual([]);
    expect(a.searchSigns).not.toHaveBeenCalled();
  });

  test("is listed only while a provider is registered", () => {
    expect(createMessageSignDataSource(ctxWith([])).isAvailable?.()).toBe(false);
    expect(createMessageSignDataSource(ctxWith([provider("a", [])])).isAvailable?.()).toBe(true);
  });

  test("opens a sign's detail from the provider that holds it", async () => {
    const source = createMessageSignDataSource(ctxWith([provider("a", [sign({ id: "a:1" })])]));
    const found = await source.getDetail("a:1");
    expect(found.data?.id).toBe("a:1");
    expect((await source.getDetail("missing")).data).toBeNull();
  });
});
