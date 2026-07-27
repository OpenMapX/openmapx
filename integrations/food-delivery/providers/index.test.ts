import { describe, expect, it } from "vitest";
import type { DeliveryProviderConfig, DeliveryQuery } from "../types.js";
import { getDeliveryProvider, providerServes } from "./index.js";

const NO_CONFIG: DeliveryProviderConfig = {};

/** Look up a provider, asserting it exists. */
function prov(id: string) {
  const p = getDeliveryProvider(id);
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
}

/** Build the deep link for a provider id. */
function build(id: string, q: DeliveryQuery): string {
  return prov(id).build(q, NO_CONFIG);
}

describe("food-delivery deep-link builders", () => {
  it("declares an honest fallback kind for every provider", () => {
    for (const provider of ["ubereats", "wolt", "lieferando", "doordash", "deliveroo", "justeat"]) {
      expect(["search", "browse"]).toContain(prov(provider).fallbackKind);
    }
    expect(prov("lieferando").fallbackKind).toBe("browse");
    expect(prov("wolt").fallbackKind).toBe("search");
  });
  // Restaurants verified live in a browser while fixing these builders.
  it("rappi uses the country TLD + /search (bare rappi.com drops the query)", () => {
    expect(build("rappi", { name: "El Califa", city: "Mexico City", countryCode: "mx" })).toBe(
      "https://www.rappi.com.mx/search?query=El%20Califa",
    );
    expect(build("rappi", { name: "Coco Bambu", countryCode: "br" })).toBe(
      "https://www.rappi.com.br/search?query=Coco%20Bambu",
    );
  });

  it("talabat uses the /<country>/<name> brand page; Iraq is its own subdomain", () => {
    expect(build("talabat", { name: "Ravi Restaurant", countryCode: "ae" })).toBe(
      "https://www.talabat.com/uae/ravi-restaurant",
    );
    expect(build("talabat", { name: "McDonald's", countryCode: "sa" })).toBe(
      "https://www.talabat.com/ksa/mcdonalds",
    );
    // Iraq's subdomain doesn't serve /<name> brand pages → storefront root.
    expect(build("talabat", { name: "Anything", countryCode: "iq" })).toBe(
      "https://iraq.talabat.com/",
    );
  });

  it("zomato uses the city brand page; Delhi→ncr, Bengaluru→bangalore", () => {
    expect(build("zomato", { name: "Karim's", city: "Delhi", countryCode: "in" })).toBe(
      "https://www.zomato.com/ncr/restaurants/karims",
    );
    expect(
      build("zomato", { name: "Empire Restaurant", city: "Bengaluru", countryCode: "in" }),
    ).toBe("https://www.zomato.com/bangalore/restaurants/empire-restaurant");
    // Zomato now operates only in India + UAE.
    expect(providerServes(prov("zomato"), "us")).toBe(false);
    expect(providerServes(prov("zomato"), "in")).toBe(true);
  });

  it("foodpanda uses the country host + /city (not the global .com router); TH dropped", () => {
    expect(build("foodpanda", { name: "Sushi Tei", city: "Singapore", countryCode: "sg" })).toBe(
      "https://www.foodpanda.sg/city/singapore",
    );
    expect(build("foodpanda", { name: "x", city: "Taipei", countryCode: "tw" })).toBe(
      "https://www.foodpanda.com.tw/city/taipei",
    );
    expect(providerServes(prov("foodpanda"), "th")).toBe(false);
  });

  it("glovo uses the /en/<country>/<city> landing (not the dropped ?search=)", () => {
    expect(build("glovo", { name: "100 Montaditos", city: "Madrid", countryCode: "es" })).toBe(
      "https://glovoapp.com/en/es/madrid",
    );
  });

  it("pedidosya uses the country host + /restaurantes/<city>; Chile is .cl", () => {
    expect(build("pedidosya", { name: "Kentucky", city: "Buenos Aires", countryCode: "ar" })).toBe(
      "https://www.pedidosya.com.ar/restaurantes/buenos-aires",
    );
    expect(build("pedidosya", { name: "x", city: "Santiago", countryCode: "cl" })).toBe(
      "https://www.pedidosya.cl/restaurantes/santiago",
    );
  });

  it("deliveroo uses the country domain + /cities/<city>; Qatar domain is .com.qa", () => {
    expect(build("deliveroo", { name: "Dishoom", city: "London", countryCode: "gb" })).toBe(
      "https://deliveroo.co.uk/cities/london/",
    );
    expect(build("deliveroo", { name: "x", city: "Doha", countryCode: "qa" })).toBe(
      "https://deliveroo.com.qa/cities/doha/",
    );
  });

  it("lieferando uses /lieferservice-<city> (not the invalid /en/takeaway/)", () => {
    expect(build("lieferando", { name: "Burgermeister", city: "Berlin", countryCode: "de" })).toBe(
      "https://www.lieferando.de/lieferservice-berlin",
    );
    expect(build("lieferando", { name: "x", city: "Wien", countryCode: "at" })).toBe(
      "https://www.lieferando.at/lieferservice-wien",
    );
  });

  it("just eat uses /takeaway/<city> for UK/IE", () => {
    expect(build("justeat", { name: "Franco Manca", city: "London", countryCode: "gb" })).toBe(
      "https://www.just-eat.co.uk/takeaway/london",
    );
  });

  it("no fixed provider still emits the old broken /search?q= path", () => {
    for (const id of ["deliveroo", "justeat", "rappi", "pedidosya", "zomato", "talabat", "glovo"]) {
      const url = build(id, { name: "Test Place", city: "Test City", countryCode: "xx" });
      expect(url).not.toContain("/search?q=");
    }
  });

  it("wolt city-scopes via the alpha-3 country path", () => {
    expect(build("wolt", { name: "Burgermeister", city: "Berlin", countryCode: "de" })).toBe(
      "https://wolt.com/en/deu/berlin/search?q=Burgermeister",
    );
  });

  it("uber eats builds the location-feed URL and appends the operator scid", () => {
    const q: DeliveryQuery = {
      name: "Joe's Pizza",
      city: "New York",
      countryCode: "us",
      lat: 40.73,
      lng: -74,
    };
    const base = prov("ubereats").build(q, NO_CONFIG);
    expect(base.startsWith("https://www.ubereats.com/feed?diningMode=DELIVERY&pl=")).toBe(true);
    const withScid = prov("ubereats").build(q, { uberEatsScid: "abc123" });
    expect(withScid).toContain("&scid=abc123");
  });

  it("wraps the final URL in an operator affiliate template", () => {
    const url = prov("rappi").build(
      { name: "X", countryCode: "mx" },
      { affiliateTemplates: { rappi: "https://aff.example/?u={url}" } },
    );
    expect(url).toBe(
      `https://aff.example/?u=${encodeURIComponent("https://www.rappi.com.mx/search?query=X")}`,
    );
  });
});
