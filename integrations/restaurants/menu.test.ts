import { describe, expect, it } from "vitest";
import { extractOrderLinks, extractOrderUrl, isDeliveryProviderWebsite } from "./menu.js";

describe("restaurant order-link discovery", () => {
  it("identifies provider storefronts that must not be crawled", () => {
    expect(isDeliveryProviderWebsite("https://wolt.com/en/deu/aachen/restaurant/test")).toBe(true);
    expect(isDeliveryProviderWebsite("https://subdomain.ubereats.com/store/test/123")).toBe(true);
    expect(isDeliveryProviderWebsite("https://deliveroo.co.uk/menu/a/b/c")).toBe(true);
    expect(isDeliveryProviderWebsite("https://foodpanda.com.tw/restaurant/test/test")).toBe(true);
    expect(isDeliveryProviderWebsite("https://rappi.com.ar/restaurantes/test")).toBe(true);
    expect(isDeliveryProviderWebsite("https://restaurant.example/menu")).toBe(false);
  });

  it("accepts a strongly signalled first-party order subdomain", () => {
    const html = '<a href="https://order.losteria.net/aachen_kapuzinergraben">Jetzt bestellen</a>';
    expect(extractOrderUrl(html, "https://losteria.net/aachen")).toBe(
      "https://order.losteria.net/aachen_kapuzinergraben",
    );
  });

  it("accepts a same-origin order path", () => {
    expect(
      extractOrderUrl(
        '<a href="/online-bestellen">Online bestellen</a>',
        "https://restaurant.example/",
      ),
    ).toBe("https://restaurant.example/online-bestellen");
  });

  it("rejects provider links and weak unrelated cross-domain links", () => {
    expect(
      extractOrderUrl(
        '<a href="https://wolt.com/en/deu/aachen/restaurant/x">Order now</a>',
        "https://restaurant.example/",
      ),
    ).toBeNull();
    expect(
      extractOrderUrl(
        '<a href="https://tickets.example/buy">Buy tickets</a>',
        "https://restaurant.example/",
      ),
    ).toBeNull();
  });

  it("returns strongly labelled provider links separately", () => {
    const links = extractOrderLinks(
      '<a href="https://wolt.com/en/deu/aachen/restaurant/test">Order now</a>',
      "https://restaurant.example/",
    );
    expect(links.directOrderUrl).toBeNull();
    expect(links.providerOrderUrls).toEqual(["https://wolt.com/en/deu/aachen/restaurant/test"]);
  });
});
