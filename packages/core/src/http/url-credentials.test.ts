import { describe, expect, it } from "vitest";
import { urlCredentialsAsBasicAuth } from "./url-credentials";

describe("urlCredentialsAsBasicAuth", () => {
  it("moves user info into a Basic header, decoding it as UTF-8", () => {
    expect(
      urlCredentialsAsBasicAuth("https://m%C3%BCller:p%40ss@overpass.example.org/api"),
    ).toEqual({
      url: "https://overpass.example.org/api",
      authorization: `Basic ${Buffer.from("müller:p@ss", "utf8").toString("base64")}`,
      secrets: ["müller", "p@ss", "m%C3%BCller", "p%40ss"],
    });
  });

  it("leaves a URL without credentials, and a non-URL, unchanged", () => {
    expect(urlCredentialsAsBasicAuth("http://overpass:80/api/status")).toEqual({
      url: "http://overpass:80/api/status",
      secrets: [],
    });
    expect(urlCredentialsAsBasicAuth("/api/status")).toEqual({ url: "/api/status", secrets: [] });
  });
});
