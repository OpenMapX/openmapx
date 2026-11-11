import { describe, expect, it } from "vitest";
import { createMockIntegrationContext } from "../testing";
import { defineTransitProvider } from "../transit-provider-factory";

const licensing = {
  version: 1,
  bindings: [
    {
      scope: "data",
      subject: "Feed data",
      license: {
        kind: "custom",
        namespace: "publisher:feed",
        id: "LicenseRef-Feed-Terms",
        name: "Feed terms",
        url: "https://feed.example/terms",
      },
    },
  ],
};

function generation(name: string) {
  const ctx = createMockIntegrationContext({
    manifest: { dataSources: [{ sourceId: "feed", name, url: "https://feed.example", licensing }] },
  } as never);
  return defineTransitProvider(ctx);
}

describe("defineTransitProvider wrapRT", () => {
  it("carries the upstream realtime age into the result's freshness", () => {
    const { wrapRT } = generation("Feed");
    const result = wrapRT([], undefined, { dataAsOf: "2026-10-31T11:59:30.000Z" });
    expect(result.freshness).toMatchObject({
      hasRealtimeData: true,
      dataAsOf: "2026-10-31T11:59:30.000Z",
    });
  });

  it("leaves the age unknown when the source states none", () => {
    const { wrapRT } = generation("Feed");
    expect(wrapRT([]).freshness).not.toHaveProperty("dataAsOf");
    expect(wrapRT([], undefined, {}).freshness).not.toHaveProperty("dataAsOf");
  });
});

describe("defineTransitProvider generations", () => {
  it("credits its own manifest from setup, before any activation", () => {
    const { attribution, wrap } = generation("Old operator");
    expect(attribution.all().map((receipt) => receipt.name)).toEqual(["Old operator"]);
    expect(wrap([{ id: "stop" }]).attributions.map((receipt) => receipt.name)).toEqual([
      "Old operator",
    ]);
  });

  it("keeps a request that started before a reload on the generation that served it", async () => {
    const old = generation("Old operator");
    const registered = old.attribution.all();
    let release: (rows: Array<{ id: string }>) => void = () => {};
    const inFlight = new Promise<Array<{ id: string }>>((resolve) => {
      release = resolve;
    }).then((rows) => old.wrapRT(rows));

    const replacement = generation("New operator");
    release([{ id: "departure" }]);
    const result = await inFlight;

    expect(result.attributions.map((receipt) => receipt.name)).toEqual(["Old operator"]);
    expect(result.data[0]).toMatchObject({ contributors: [{ name: "Old operator" }] });
    expect(registered.map((receipt) => receipt.name)).toEqual(["Old operator"]);
    expect(replacement.wrap([{ id: "departure" }]).attributions[0]?.name).toBe("New operator");
  });
});
