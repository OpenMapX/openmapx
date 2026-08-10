import { DeepLinkController, type DeepLinkSink } from "./DeepLinkController";
import type { DeepLinkConfig, DeepLinkIntent } from "./deepLinkIntent";

const CONFIG: DeepLinkConfig = { webOrigin: "https://openmapx.com", scheme: "openmapx" };

function harness() {
  const initialUrls: string[] = [];
  const delivered: DeepLinkIntent[] = [];
  const sink: DeepLinkSink = {
    setInitialUrl: (url) => initialUrls.push(url),
    deliver: (intent) => delivered.push(intent),
  };
  return { controller: new DeepLinkController(CONFIG, sink), initialUrls, delivered };
}

describe("DeepLinkController cold start", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("points the WebView at the canonical origin", () => {
    expect(h.controller.handle("https://openmapx.com/?q=cafe")).toBe("cold-start");

    expect(h.initialUrls).toEqual(["https://openmapx.com/?q=cafe"]);
    expect(h.delivered).toEqual([]);
  });

  it("builds the URL from the compiled origin, not the link", () => {
    h.controller.handle("openmapx://?q=cafe");

    // A scheme link has no origin of its own to contribute, and an HTTPS one is
    // not allowed to contribute the one it has.
    expect(h.initialUrls[0]).toBe("https://openmapx.com/?q=cafe");
  });

  it("refuses a link it does not recognise without touching the WebView", () => {
    expect(h.controller.handle("https://evil.example/?q=cafe")).toBe("refused");

    expect(h.initialUrls).toEqual([]);
  });
});

describe("DeepLinkController warm delivery", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.controller.markWarm();
  });

  it("sends a bounded intent instead of reloading the page", () => {
    expect(h.controller.handle("https://openmapx.com/?q=cafe")).toBe("delivered");

    // Reloading would throw away whatever the user was in the middle of.
    expect(h.delivered).toEqual([{ kind: "map", query: "?q=cafe" }]);
    expect(h.initialUrls).toEqual([]);
  });

  it("delivers the active-navigation intent as a screen request", () => {
    h.controller.handle("openmapx://navigation/active");

    expect(h.delivered).toEqual([{ kind: "active-navigation" }]);
  });
});

describe("DeepLinkController duplicate delivery", () => {
  it("acts once on a link the OS delivers twice", () => {
    const h = harness();
    h.controller.markWarm();

    expect(h.controller.handle("https://openmapx.com/?q=cafe")).toBe("delivered");
    expect(h.controller.handle("https://openmapx.com/?q=cafe")).toBe("duplicate");

    // A notification tapped while the app is resuming arrives as both a launch
    // URL and a URL event; acting on both navigates the user twice.
    expect(h.delivered).toHaveLength(1);
  });

  it("still acts on a genuinely different link", () => {
    const h = harness();
    h.controller.markWarm();
    h.controller.handle("https://openmapx.com/?q=cafe");

    expect(h.controller.handle("https://openmapx.com/?q=museum")).toBe("delivered");
    expect(h.delivered).toHaveLength(2);
  });

  it("acts again on the same link after the page reloaded", () => {
    const h = harness();
    h.controller.markWarm();
    h.controller.handle("https://openmapx.com/?q=cafe");

    h.controller.markCold();
    h.controller.markWarm();

    // Whatever it did the first time went away with the page.
    expect(h.controller.handle("https://openmapx.com/?q=cafe")).toBe("delivered");
  });

  it("returns to cold delivery when the page goes away", () => {
    const h = harness();
    h.controller.markWarm();
    h.controller.markCold();

    expect(h.controller.handle("https://openmapx.com/?q=cafe")).toBe("cold-start");
  });
});
