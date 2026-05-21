import { describe, expect, it } from "vitest";
import { getIdSchemeView, registerBuiltinIdSchemeViews } from ".";
import { buildTripadvisorUrl } from "./tripadvisor";

describe("buildTripadvisorUrl", () => {
  it("builds URLs from Wikidata-style path values", () => {
    expect(
      buildTripadvisorUrl(
        "Attraction_Review-g187147-d188151-Reviews-Eiffel_Tower-Paris_Ile_de_France.html",
      ),
    ).toBe(
      "https://www.tripadvisor.com/Attraction_Review-g187147-d188151-Reviews-Eiffel_Tower-Paris_Ile_de_France.html",
    );
  });

  it("preserves path slashes without accepting arbitrary external hosts", () => {
    expect(buildTripadvisorUrl("/Restaurant_Review/g187323-d100-Reviews-Cafe.html")).toBe(
      "https://www.tripadvisor.com/Restaurant_Review/g187323-d100-Reviews-Cafe.html",
    );
    expect(buildTripadvisorUrl("https://tripadvisor.com.evil.example/fake")).toBeUndefined();
  });

  it("accepts safe localized Tripadvisor hosts and strips tracking parameters", () => {
    expect(
      buildTripadvisorUrl(
        "https://www.tripadvisor.co.uk/Attraction_Review-g186338-d187555-Reviews.html?utm_source=share&foo=bar#gref",
      ),
    ).toBe("https://www.tripadvisor.co.uk/Attraction_Review-g186338-d187555-Reviews.html?foo=bar");
  });

  it("rejects unsafe or malformed values", () => {
    expect(buildTripadvisorUrl("javascript:alert(1)")).toBeUndefined();
    expect(buildTripadvisorUrl("Restaurant Review With Spaces")).toBeUndefined();
    expect(buildTripadvisorUrl("https://www.tripadvisor.com/")).toBeUndefined();
  });

  it("is used by the builtin Tripadvisor id-scheme view", () => {
    registerBuiltinIdSchemeViews();
    expect(getIdSchemeView("tripadvisor")?.buildUrl?.("Restaurant_Review-g1-d2.html")).toBe(
      "https://www.tripadvisor.com/Restaurant_Review-g1-d2.html",
    );
  });
});
