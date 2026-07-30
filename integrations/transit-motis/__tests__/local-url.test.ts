import { describe, expect, it } from "vitest";
import { resolveLocalMotisUrl } from "../local.js";

describe("resolveLocalMotisUrl", () => {
  it("prefers the service registry and trims its URL", () => {
    expect(
      resolveLocalMotisUrl(
        "  http://motis:8080  ",
        "https://configured.example",
        "https://environment.example",
      ),
    ).toBe("http://motis:8080");
  });

  it("skips blank candidates instead of configuring an empty base URL", () => {
    expect(resolveLocalMotisUrl(undefined, "   ", " https://environment.example ")).toBe(
      "https://environment.example",
    );
  });

  it("uses the localhost fallback when no non-empty candidate exists", () => {
    expect(resolveLocalMotisUrl(null, undefined, "")).toBe("http://localhost:8081");
  });
});
