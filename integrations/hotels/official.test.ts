import type { Logger } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
  safeFetchTextResponse: vi.fn(),
}));

vi.mock("@openmapx/core/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core/server")>();
  return {
    ...actual,
    safeFetchTextResponse: serverMocks.safeFetchTextResponse,
  };
});

import { extractOfficialBookingUrl, fetchOfficialBookingUrl } from "./official.js";

const dates = { checkIn: "2026-06-10", checkOut: "2026-06-12", adults: 2, rooms: 1 };
const BOOKING_HTML = '<a href="https://be.synxis.com/?hotel=12345&chain=10">Book now</a>';
const log = { debug: vi.fn() } as unknown as Logger;

beforeEach(() => {
  serverMocks.safeFetchTextResponse.mockReset().mockResolvedValue({
    text: BOOKING_HTML,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    finalUrl: "https://hotel.example",
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(BOOKING_HTML, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractOfficialBookingUrl", () => {
  it("fills a schema.org ReserveAction urlTemplate", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Hotel",
      name: "Test Hotel",
      potentialAction: {
        "@type": "ReserveAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: "https://book.testhotel.com/?in={checkin}&out={checkout}",
        },
      },
    })}</script>`;
    expect(extractOfficialBookingUrl(html, "https://www.testhotel.com/", dates)).toBe(
      "https://book.testhotel.com/?in=2026-06-10&out=2026-06-12",
    );
  });

  it("detects a SynXis booking-engine link and appends dates", () => {
    const html = `<a href="https://be.synxis.com/?hotel=12345&chain=10">Book now</a>`;
    const url = extractOfficialBookingUrl(html, "https://www.grandhotel.com/", dates);
    expect(url).toContain("https://be.synxis.com/?hotel=12345");
    expect(url).toContain("arrive=2026-06-10");
    expect(url).toContain("depart=2026-06-12");
  });

  it("passes through a property-specific engine link without inventing params", () => {
    const html = `<iframe src="https://app.mews.com/distributor/abcdef"></iframe>`;
    expect(extractOfficialBookingUrl(html, "https://hotel.example/", dates)).toBe(
      "https://app.mews.com/distributor/abcdef",
    );
  });

  it("returns null when the page has no official booking link", () => {
    expect(
      extractOfficialBookingUrl(`<a href="/about">About us</a>`, "https://x.example/", dates),
    ).toBeNull();
  });
});

describe("official hotel website acquisition", () => {
  it("resolves relative booking targets against the final redirected URL", async () => {
    const redirectedHtml = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Hotel",
      potentialAction: {
        "@type": "ReserveAction",
        target: { url: "/official-booking" },
      },
    })}</script>`;
    serverMocks.safeFetchTextResponse.mockResolvedValue({
      text: redirectedHtml,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      finalUrl: "https://redirected.hotel.example/stay",
    });

    await expect(fetchOfficialBookingUrl("https://hotel.example", dates, log)).resolves.toBe(
      "https://redirected.hotel.example/official-booking",
    );
  });

  it("returns null when connection-time DNS changes to a private address", async () => {
    serverMocks.safeFetchTextResponse.mockRejectedValue(
      new Error('URL host "hotel.example" is not allowed'),
    );

    await expect(fetchOfficialBookingUrl("https://hotel.example", dates, log)).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null when a redirect targets a private address", async () => {
    serverMocks.safeFetchTextResponse.mockRejectedValue(
      new Error('URL host "127.0.0.1" is not allowed'),
    );

    await expect(fetchOfficialBookingUrl("https://hotel.example", dates, log)).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns null when the pinned request times out", async () => {
    serverMocks.safeFetchTextResponse.mockRejectedValue(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(fetchOfficialBookingUrl("https://hotel.example", dates, log)).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves deliberate 800,000-byte truncation", async () => {
    const oversizedHtml = `${BOOKING_HTML}${"x".repeat(900_000)}`;
    serverMocks.safeFetchTextResponse.mockResolvedValue({
      text: oversizedHtml.slice(0, 800_000),
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      finalUrl: "https://hotel.example",
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(oversizedHtml, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await fetchOfficialBookingUrl("https://hotel.example", dates, log);

    expect(result).toContain("https://be.synxis.com/?hotel=12345");
    expect(serverMocks.safeFetchTextResponse).toHaveBeenCalledWith(
      "https://hotel.example",
      expect.objectContaining({
        acceptedContentTypes: ["text/html", "application/xhtml+xml", "text/plain"],
        maxBytes: 800_000,
        truncate: true,
      }),
    );
  });

  it("propagates caller cancellation into the pinned request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("fixture canceled"));
    serverMocks.safeFetchTextResponse.mockImplementation(
      async (_url: string, options: { signal?: AbortSignal }) => {
        options.signal?.throwIfAborted();
        return {
          text: BOOKING_HTML,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          finalUrl: "https://hotel.example",
        };
      },
    );

    await expect(
      fetchOfficialBookingUrl("https://hotel.example", dates, log, controller.signal),
    ).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
