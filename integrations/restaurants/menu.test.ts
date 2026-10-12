import type { Logger } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
  safeFetchText: vi.fn(),
}));

vi.mock("@openmapx/core/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core/server")>();
  return {
    ...actual,
    safeFetchText: serverMocks.safeFetchText,
  };
});

import {
  extractOrderLinks,
  extractOrderUrl,
  isDeliveryProviderWebsite,
  resolveRestaurantLinks,
} from "./menu.js";

const HOME_HTML = '<a href="/menu">View menu</a>';
const log = { debug: vi.fn() } as unknown as Logger;

beforeEach(() => {
  serverMocks.safeFetchText
    .mockReset()
    .mockImplementation(async (url: string) => (url.endsWith("/robots.txt") ? "" : HOME_HTML));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    Promise.resolve(
      new Response(String(input).endsWith("/robots.txt") ? "" : HOME_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("restaurant website acquisition", () => {
  it("returns no links when connection-time DNS changes to a private address", async () => {
    serverMocks.safeFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return "";
      throw new Error('URL host "restaurant.example" is not allowed');
    });

    await expect(resolveRestaurantLinks("https://restaurant.example", log)).resolves.toEqual({
      menu: null,
      orderUrl: null,
      providerOrderUrls: [],
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns no links when a redirect targets a private address", async () => {
    serverMocks.safeFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return "";
      throw new Error('URL host "127.0.0.1" is not allowed');
    });

    await expect(resolveRestaurantLinks("https://restaurant.example", log)).resolves.toEqual({
      menu: null,
      orderUrl: null,
      providerOrderUrls: [],
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns no links when the pinned request times out", async () => {
    serverMocks.safeFetchText.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return "";
      throw new DOMException("The operation timed out", "TimeoutError");
    });

    await expect(resolveRestaurantLinks("https://restaurant.example", log)).resolves.toEqual({
      menu: null,
      orderUrl: null,
      providerOrderUrls: [],
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves deliberate 800,000-byte truncation", async () => {
    const oversizedHtml = `${HOME_HTML}${"x".repeat(900_000)}`;
    serverMocks.safeFetchText.mockImplementation(async (url: string) =>
      url.endsWith("/robots.txt") ? "" : oversizedHtml.slice(0, 800_000),
    );
    vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
      Promise.resolve(
        new Response(String(input).endsWith("/robots.txt") ? "" : oversizedHtml, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await resolveRestaurantLinks("https://restaurant.example", log);

    expect(result.menu).toMatchObject({
      menuUrl: "https://restaurant.example/menu",
      source: "heuristic",
    });
    expect(serverMocks.safeFetchText).toHaveBeenNthCalledWith(
      2,
      "https://restaurant.example/",
      expect.objectContaining({
        acceptedContentTypeSubstrings: ["html", "text"],
        maxBytes: 800_000,
        truncate: true,
      }),
    );
  });

  it("propagates caller cancellation into each pinned request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("fixture canceled"));
    serverMocks.safeFetchText.mockImplementation(
      async (_url: string, options: { signal?: AbortSignal }) => {
        options.signal?.throwIfAborted();
        return HOME_HTML;
      },
    );

    await expect(
      resolveRestaurantLinks("https://restaurant.example", log, controller.signal),
    ).resolves.toEqual({ menu: null, orderUrl: null, providerOrderUrls: [] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
