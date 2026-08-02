import { describe, expect, it } from "vitest";
import { registryEndpointRejection } from "../validate-endpoint";

describe("registryEndpointRejection", () => {
  it("allows entries without an endpoint", () => {
    expect(registryEndpointRejection({})).toBeNull();
  });

  it("allows a public HTTPS endpoint", () => {
    expect(
      registryEndpointRejection({ endpoint: "https://fahrplan.oebb.at/bin/mgate.exe" }),
    ).toBeNull();
  });

  it("allows public HTTP when no credential is present", () => {
    expect(registryEndpointRejection({ endpoint: "http://api.example.org/graphql" })).toBeNull();
  });

  it.each([
    "http://127.0.0.1:8080/graphql",
    "http://localhost:8080/graphql",
    "http://10.0.0.5/otp",
    "http://[::1]/otp",
    "ftp://example.org/otp",
    "file:///etc/passwd",
    "not-a-url",
  ])("rejects unsafe URL %s", (endpoint) => {
    expect(registryEndpointRejection({ endpoint })).toBe("not-public-http");
  });

  it("rejects a non-string endpoint", () => {
    expect(registryEndpointRejection({ endpoint: 42 })).toBe("not-a-string");
  });

  it.each([
    { endpoint: "http://api.example.org/graphql", apiKey: "x" },
    { endpoint: "http://api.example.org/graphql", auth: { token: "x" } },
  ])("rejects credentials sent over plain HTTP", (options) => {
    expect(registryEndpointRejection(options)).toBe("insecure-with-credential");
  });

  it("allows credentials over HTTPS", () => {
    expect(
      registryEndpointRejection({ endpoint: "https://api.example.org/graphql", apiKey: "x" }),
    ).toBeNull();
  });
});
