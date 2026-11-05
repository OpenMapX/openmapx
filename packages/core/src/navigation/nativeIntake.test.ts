import { describe, expect, it } from "vitest";
import {
  classifySharedText,
  INTAKE_CHUNK_BYTES,
  intakeItemSchema,
  MAX_INTAKE_FILE_BYTES,
} from "./nativeIntake";

const config = { webOrigin: "https://openmapx.com", scheme: "openmapx" };
const params = (text: string) => {
  const result = classifySharedText(text, config);
  expect(result.kind).toBe("map");
  if (result.kind !== "map") throw new Error("not a map intent");
  return new URLSearchParams(result.query);
};
describe("native intake contracts", () => {
  it("bounds metadata and never accepts a native file path", () => {
    const item = {
      id: "12345678-1234-4234-8234-123456789abc",
      kind: "file",
      name: "route.gpx",
      format: "gpx",
      createdAtMs: 1000,
      byteLength: 42,
    };
    expect(intakeItemSchema.safeParse(item).success).toBe(true);
    expect(intakeItemSchema.safeParse({ ...item, path: "/private/secret" }).success).toBe(false);
    expect(
      intakeItemSchema.safeParse({ ...item, byteLength: MAX_INTAKE_FILE_BYTES + 1 }).success,
    ).toBe(false);
    expect(intakeItemSchema.safeParse({ ...item, id: "../secret" }).success).toBe(false);
    expect(INTAKE_CHUNK_BYTES).toBe(24576);
  });
});
describe("classifySharedText", () => {
  it("searches ordinary addresses without choosing another server", () => {
    expect(params("  Bahnhofstraße 12, München ").get("q")).toBe("Bahnhofstraße 12, München");
  });
  it.each(["50.11,8.68", "geo:50.11,8.68", "geo:0,0?q=50.11,8.68(Station)"])(
    "recognizes an explicit point: %s",
    (value) => {
      const p = params(value);
      expect(p.get("at")).toBe("50.11,8.68");
      expect(p.get("panel")).toBe("place");
    },
  );
  it("uses an address query in geo URIs", () =>
    expect(params("geo:0,0?q=Frankfurt+Hauptbahnhof").get("q")).toBe("Frankfurt Hauptbahnhof"));
  it.each([
    "https://maps.apple.com/?ll=50.11,8.68&q=Station",
    "https://www.google.com/maps/search/?api=1&query=50.11,8.68",
    "https://www.openstreetmap.org/?mlat=50.11&mlon=8.68#map=15/50.11/8.68",
  ])("uses coordinates from a recognized map link: %s", (value) =>
    expect(params(value).get("at")).toBe("50.11,8.68"),
  );
  it("retains a useful label beside an unresolved short link without fetching", () =>
    expect(params("Frankfurt Hauptbahnhof\nhttps://maps.app.goo.gl/example").get("q")).toBe(
      "Frankfurt Hauptbahnhof",
    ));
  it("accepts own-origin map links without accepting another backend", () =>
    expect(params("https://openmapx.com/?q=Station").get("q")).toBe("Station"));
  it.each([
    "file:///private/route.gpx",
    "https://evil.example/?q=Station",
    "https://openmapx.com.evil.example/?q=x",
    "https://openmapx.com:444/?q=x",
    "https://user@openmapx.com/?q=x",
    "javascript:alert(1)",
    "91,8",
    "geo:91,8",
    "",
    "a".repeat(4097),
  ])("refuses ambiguous or hostile input: %s", (value) =>
    expect(classifySharedText(value, config).kind).toBe("unsupported"),
  );
});

it("retains explicit geo coordinates when a sender also provides a location label", () => {
  expect(
    classifySharedText("Station\ngeo:50,8", {
      webOrigin: "https://openmapx.com",
      scheme: "openmapx",
    }),
  ).toMatchObject({ kind: "map" });
});

it.each([
  "tel:+493012345",
  "Tel:+493012345",
  "mailto:cafe@example.com",
  "https://example.com/menu",
])("does not let %s hide a later map link", (line) => {
  expect(params(`Café\n${line}\nhttps://maps.google.com/?q=52.5,13.4`).get("at")).toBe("52.5,13.4");
});

it.each([
  [
    "https://maps.apple.com/place?coordinate=48.137,11.575&name=Marienplatz",
    "48.137,11.575",
    "Marienplatz",
  ],
  ["https://maps.apple.com/frame?center=48.137,11.575", "48.137,11.575", "48.137,11.575"],
  [
    "https://www.google.com/maps/place/Marienplatz/@48.137,11.575,17z",
    "48.137,11.575",
    "Marienplatz",
  ],
])("recognizes current map URLs: %s", (url, at, name) => {
  expect(params(url).get("at")).toBe(at);
  expect(params(url).get("name")).toBe(name);
});
it("recognizes unified Apple search URLs", () => {
  expect(params("https://maps.apple.com/search?query=coffee").get("q")).toBe("coffee");
});
it("uses a decoded Google place name when no explicit point is available", () => {
  expect(params("https://www.google.com/maps/place/Caf%C3%A9+Central/").get("q")).toBe(
    "Café Central",
  );
});
it.each([
  "https://maps.apple.com/place?coordinate=91,11&name=Station",
  "https://www.google.com/maps/place/Station/@91,11,17z",
  "https://www.google.com/maps/place/%ZZ/",
  "https://maps.apple/p/example",
  "https://maps.app.goo.gl/example",
])("does not fetch short links or accept invalid map locations: %s", (url) => {
  expect(classifySharedText(url, config).kind).toBe("unsupported");
});
