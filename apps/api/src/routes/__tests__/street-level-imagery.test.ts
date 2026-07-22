import { describe, expect, it, vi } from "vitest";

// Stub out integration-host so importing ../street-level-imagery doesn't transitively
// pull in auth.ts (which requires BETTER_AUTH_SECRET). These cases exercise
// only the pure ordering helper.
vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: () => [],
  getIntegrationProviders: () => [],
}));

import { orderProviders } from "../street-level-imagery";

const CAPS = [
  { id: "mapillary", name: "Mapillary" },
  { id: "panoramax", name: "Panoramax" },
];

describe("orderProviders", () => {
  it("orders by the configured chain", () => {
    expect(orderProviders(CAPS, "panoramax,mapillary").map((c) => c.id)).toEqual([
      "panoramax",
      "mapillary",
    ]);
  });

  it("excludes providers absent from the chain", () => {
    expect(orderProviders(CAPS, "panoramax").map((c) => c.id)).toEqual(["panoramax"]);
  });

  it("ignores unknown ids in the chain", () => {
    expect(orderProviders(CAPS, "panoramax,nope").map((c) => c.id)).toEqual(["panoramax"]);
  });

  it("tolerates whitespace and empty entries", () => {
    expect(orderProviders(CAPS, " panoramax , , mapillary ").map((c) => c.id)).toEqual([
      "panoramax",
      "mapillary",
    ]);
  });

  it("falls back to panoramax when the chain is empty", () => {
    expect(orderProviders(CAPS, "").map((c) => c.id)).toEqual(["panoramax"]);
  });
});
