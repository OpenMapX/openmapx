import { describe, expect, it } from "vitest";
import { extractOfficialBookingUrl } from "./official.js";

const dates = { checkIn: "2026-06-10", checkOut: "2026-06-12", adults: 2, rooms: 1 };

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
