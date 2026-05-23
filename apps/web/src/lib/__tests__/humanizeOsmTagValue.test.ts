import { describe, expect, it } from "vitest";
import { humanizeOsmTagValue } from "../humanizeOsmTagValue";

describe("humanizeOsmTagValue", () => {
  it("humanizes snake_case lowercase identifiers", () => {
    expect(humanizeOsmTagValue("cambio_stadtmobil")).toBe("Cambio Stadtmobil");
    expect(humanizeOsmTagValue("deutsche_bahn")).toBe("Deutsche Bahn");
    expect(humanizeOsmTagValue("park_and_ride")).toBe("Park And Ride");
  });

  it("preserves already-humanized brands", () => {
    expect(humanizeOsmTagValue("Cambio Stadtmobil")).toBe("Cambio Stadtmobil");
    expect(humanizeOsmTagValue("Cambio CarSharing")).toBe("Cambio CarSharing");
    expect(humanizeOsmTagValue("BMW")).toBe("BMW");
    expect(humanizeOsmTagValue("iPhone")).toBe("iPhone");
    expect(humanizeOsmTagValue("4Wash")).toBe("4Wash");
  });

  it("leaves single-word lowercase brands alone", () => {
    expect(humanizeOsmTagValue("aldi")).toBe("aldi");
    expect(humanizeOsmTagValue("rewe")).toBe("rewe");
  });

  it("leaves values containing non-ASCII or punctuation alone", () => {
    expect(humanizeOsmTagValue("müller")).toBe("müller");
    expect(humanizeOsmTagValue("hello-world")).toBe("hello-world");
    expect(humanizeOsmTagValue("a.b")).toBe("a.b");
  });

  it("handles edge cases", () => {
    expect(humanizeOsmTagValue("")).toBe("");
    expect(humanizeOsmTagValue("_")).toBe("");
    expect(humanizeOsmTagValue("a_")).toBe("A");
    expect(humanizeOsmTagValue("__double__")).toBe("Double");
  });
});
