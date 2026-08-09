import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

/** Every feed answers with a parseable discovery document, so probes pass. */
const stubFetch = vi.fn(async () => ({
  data: { en: { feeds: [{ name: "zones", url: "https://x/zones" }] } },
}));

const feeds = [
  { id: "example", name: "Example Taxi", url: "https://feed.example/gofs.json" },
  { id: "other", name: "Other Transit", url: "https://other.example/gofs.json" },
];

/** No upstream registry in these tests — only the operator's own feeds. */
function ctxWith(config: Record<string, unknown>) {
  return createMockIntegrationContext({
    id: "ride-gofs",
    config: { useUpstreamCatalog: false, ...config },
  });
}

describe("ride-gofs setup", () => {
  it("registers one provider per resolved feed", async () => {
    const ctx = ctxWith({ feeds });
    await setup(ctx, stubFetch);
    expect(ctx.registered.ride.map((p) => p.id)).toEqual(["gofs-example", "gofs-other"]);
  });

  it("registers nothing when no feeds resolve", async () => {
    const ctx = ctxWith({});
    await setup(ctx, stubFetch);
    expect(ctx.registered.ride).toEqual([]);
  });

  it("skips a feed with a non-http url", async () => {
    const ctx = ctxWith({
      feeds: [{ id: "bad", name: "Bad", url: "file:///etc/passwd" }, ...feeds],
    });
    await setup(ctx, stubFetch);
    expect(ctx.registered.ride.map((p) => p.id)).toEqual(["gofs-example", "gofs-other"]);
  });

  it("skips a feed missing an id or url", async () => {
    const ctx = ctxWith({
      feeds: [{ name: "No id", url: "https://x.example/gofs.json" }, { id: "no-url" }],
    });
    await setup(ctx, stubFetch);
    expect(ctx.registered.ride).toEqual([]);
  });

  it("drops a duplicate feed id rather than registering it twice", async () => {
    const ctx = ctxWith({ feeds: [feeds[0], { ...feeds[0], name: "Dup" }] });
    await setup(ctx, stubFetch);
    expect(ctx.registered.ride.map((p) => p.id)).toEqual(["gofs-example"]);
  });
});
