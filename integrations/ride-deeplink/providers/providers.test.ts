import { describe, expect, it } from "vitest";
import { DEEPLINK_PROVIDERS, getDeepLinkProvider } from "./index.js";

const request = {
  pickup: [13.405, 52.52] as [number, number],
  dropoff: [13.377, 52.516] as [number, number],
  pickupAddress: "Alexanderplatz",
  dropoffAddress: "Reichstag",
};

describe("uber", () => {
  it("encodes the universal link's locations as JSON under pickup and drop[0]", () => {
    const handoff = getDeepLinkProvider("uber")?.build(request, { uberClientId: "abc123" });
    const url = new URL(handoff?.webUrl ?? "");
    expect(url.host).toBe("m.uber.com");
    expect(url.pathname).toBe("/looking");
    expect(url.searchParams.get("client_id")).toBe("abc123");
    expect(JSON.parse(url.searchParams.get("pickup") ?? "{}")).toEqual({
      latitude: 52.52,
      longitude: 13.405,
      formatted_address: "Alexanderplatz",
    });
    expect(JSON.parse(url.searchParams.get("drop[0]") ?? "{}")).toEqual({
      latitude: 52.516,
      longitude: 13.377,
      formatted_address: "Reichstag",
    });
    expect(handoff?.carriesCoordinates).toBe(true);
  });

  it("uses flat bracketed scalars on the app scheme, with dropoff not drop", () => {
    const handoff = getDeepLinkProvider("uber")?.build(request, { uberClientId: "abc123" });
    const app = new URL(handoff?.androidUrl ?? "");
    expect(app.protocol).toBe("uber:");
    expect(app.searchParams.get("pickup[latitude]")).toBe("52.52");
    expect(app.searchParams.get("dropoff[longitude]")).toBe("13.377");
    expect(app.searchParams.get("drop[0]")).toBeNull();
  });

  it("does not claim to carry coordinates on the web without a client id", () => {
    // Uber documents client_id as required on the universal link, so an
    // unconfigured deployment must not promise a prefilled web handoff.
    const handoff = getDeepLinkProvider("uber")?.build(request, {});
    expect(handoff?.webUrl).toBe("https://m.uber.com/");
    expect(handoff?.carriesCoordinates).toBe(false);
    expect(handoff?.webUrl).not.toContain("52.52");
  });

  it("still carries the trip on the app scheme without a client id", () => {
    const handoff = getDeepLinkProvider("uber")?.build(request, {});
    expect(handoff?.androidUrl).toContain("pickup%5Blatitude%5D=52.52");
    expect(handoff?.androidUrl).not.toContain("client_id");
  });
});

describe("lyft", () => {
  it("carries pickup and destination coordinates", () => {
    const handoff = getDeepLinkProvider("lyft")?.build(request, {});
    const url = new URL(handoff?.webUrl ?? "");
    expect(url.host).toBe("lyft.com");
    expect(url.searchParams.get("id")).toBe("lyft");
    expect(url.searchParams.get("pickup[latitude]")).toBe("52.52");
    expect(url.searchParams.get("destination[longitude]")).toBe("13.377");
  });

  it("adds the partner id when configured", () => {
    const handoff = getDeepLinkProvider("lyft")?.build(request, { lyftPartnerId: "p-1" });
    expect(new URL(handoff?.webUrl ?? "").searchParams.get("partner")).toBe("p-1");
  });
});

describe("coordinate-less providers", () => {
  it.each(["bolt", "freenow", "yango"])("%s emits no coordinates at all", (id) => {
    const handoff = getDeepLinkProvider(id)?.build(request, {});
    expect(handoff?.carriesCoordinates).toBe(false);
    expect(handoff?.webUrl).not.toContain("52.52");
    expect(handoff?.webUrl).not.toContain("13.405");
    expect(handoff?.webUrl).not.toContain("Alexanderplatz");
  });
});

describe("registry", () => {
  it("has unique ids and https homepages", () => {
    const ids = DEEPLINK_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of DEEPLINK_PROVIDERS) {
      expect(p.homepage.startsWith("https://")).toBe(true);
    }
  });

  it("returns undefined for an unknown id", () => {
    expect(getDeepLinkProvider("nope")).toBeUndefined();
  });
});
