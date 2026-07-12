import { describe, expect, it } from "vitest";
import {
  buildReportClaim,
  domainForCategory,
  fuzzinessForChoice,
  generateNonce,
  REPORT_CATEGORIES,
} from "../claim.js";

describe("fuzzinessForChoice", () => {
  it("maps the four picker choices to the wire fuzziness values", () => {
    expect(fuzzinessForChoice("here")).toBe("exact");
    expect(fuzzinessForChoice("ahead")).toBe("end_unknown");
    expect(fuzzinessForChoice("back_of_queue")).toBe("start_unknown");
    expect(fuzzinessForChoice("all_along")).toBe("extent_unknown");
  });
});

describe("domainForCategory", () => {
  it("routes transit, place and road categories to the right domain", () => {
    expect(domainForCategory("transit_disruption")).toBe("transit");
    expect(domainForCategory("accessibility")).toBe("places");
    expect(domainForCategory("road_closure")).toBe("roads");
    expect(domainForCategory("jam")).toBe("roads");
  });

  it("does not include police in the taxonomy", () => {
    expect(REPORT_CATEGORIES).not.toContain("police");
    expect(REPORT_CATEGORIES.length).toBeLessThanOrEqual(12);
  });
});

describe("generateNonce", () => {
  it("produces a 16..64 char [A-Za-z0-9_-] token", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("clamps out-of-range lengths into the valid window", () => {
    expect(generateNonce(4)).toHaveLength(16);
    expect(generateNonce(999)).toHaveLength(64);
  });
});

describe("buildReportClaim", () => {
  it("builds a Point claim with the mapped domain/type/fuzziness", () => {
    const claim = buildReportClaim({
      category: "accident",
      fuzziness: "ahead",
      lon: 6.1,
      lat: 51.2,
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
    expect(claim).toEqual({
      domain: "roads",
      type: "accident",
      geometry: { type: "Point", coordinates: [6.1, 51.2] },
      fuzziness: "end_unknown",
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
  });

  it("includes severityLevel only when provided", () => {
    const withSeverity = buildReportClaim({
      category: "jam",
      fuzziness: "all_along",
      lon: 0,
      lat: 0,
      severityLevel: 3,
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
    expect(withSeverity.severityLevel).toBe(3);

    const withoutSeverity = buildReportClaim({
      category: "jam",
      fuzziness: "all_along",
      lon: 0,
      lat: 0,
      reportedAt: "2026-07-11T10:00:00.000Z",
      nonce: "fixednonce_1234567890",
    });
    expect(withoutSeverity).not.toHaveProperty("severityLevel");
  });

  it("defaults reportedAt and nonce when omitted", () => {
    const claim = buildReportClaim({ category: "other", fuzziness: "here", lon: 1, lat: 2 });
    expect(claim.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(() => new Date(claim.reportedAt).toISOString()).not.toThrow();
    expect(claim.fuzziness).toBe("exact");
  });
});
