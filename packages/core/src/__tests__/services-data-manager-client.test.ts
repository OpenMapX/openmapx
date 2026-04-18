import { describe, expect, it } from "vitest";
import { DataManagerClient } from "../services/data-manager-client";

describe("DataManagerClient", () => {
  it("constructs the right URL for status", () => {
    const c = new DataManagerClient({ baseUrl: "http://data-manager:4000" });
    expect(c.statusUrl()).toBe("http://data-manager:4000/status");
  });

  it("trims trailing slash from baseUrl", () => {
    const c = new DataManagerClient({ baseUrl: "http://x/" });
    expect(c.statusUrl()).toBe("http://x/status");
  });
});
