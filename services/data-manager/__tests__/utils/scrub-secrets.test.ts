import { describe, expect, it } from "vitest";
import { scrubSecrets, scrubSecretsOptional } from "../../src/utils/scrub-secrets.js";

describe("scrubSecrets", () => {
  it("strips a query-param key from a URL", () => {
    const result = scrubSecrets(
      "Command failed: curl https://feeds.example.org/gtfs.zip?api-key=FAKEKEY123",
    );
    expect(result).not.toContain("FAKEKEY123");
    expect(result).toContain("https://feeds.example.org/gtfs.zip");
  });

  it("strips alternate credential query parameters", () => {
    const result = scrubSecrets(
      "https://one.example/feed.zip?key=FAKEKEY https://two.example/feed.zip?token=FAKETOKEN https://three.example/feed.zip?apikey=FAKEAPIKEY",
    );
    expect(result).not.toContain("FAKEKEY");
    expect(result).not.toContain("FAKETOKEN");
    expect(result).not.toContain("FAKEAPIKEY");
    expect(result).toContain("https://one.example/feed.zip");
    expect(result).toContain("https://two.example/feed.zip");
    expect(result).toContain("https://three.example/feed.zip");
  });

  it("strips basic-auth userinfo", () => {
    const result = scrubSecrets(
      "git clone https://oauth2:FAKETOKEN@github.com/acme/catalog.git failed",
    );
    expect(result).not.toContain("FAKETOKEN");
    expect(result).toContain("https://github.com/acme/catalog.git");
  });

  it("strips path-embedded keys", () => {
    const result = scrubSecrets("https://tiles.example.org/key/FAKEPATHKEY/feed.zip");
    expect(result).not.toContain("FAKEPATHKEY");
    expect(result).toContain("/key/");
  });

  it("strips bearer authorization text", () => {
    const result = scrubSecrets("Authorization: Bearer FAKEBEARER");
    expect(result).not.toContain("FAKEBEARER");
    expect(result).toContain("Authorization: [redacted]");
  });

  it("strips bare credential assignments", () => {
    const result = scrubSecrets("curl --api-key=FAKEFLAGKEY --other=value");
    expect(result).not.toContain("FAKEFLAGKEY");
    expect(result).toContain("--api-key=[redacted]");
    expect(result).toContain("--other=value");
  });

  it("strips AGE ciphertext", () => {
    const result = scrubSecrets("AGE-ENCRYPTED:YWJjZGVmZ2g=");
    expect(result).not.toContain("YWJjZGVmZ2g");
    expect(result).toContain("AGE-ENCRYPTED:[redacted]");
  });

  it("scrubs credentialed URLs in multi-line execa-shaped messages", () => {
    const result = scrubSecrets(
      "Command failed with exit code 1: fetch.py de-vbb\nError: Could not fetch de-vbb from https://feeds.example.org/x.zip?token=FAKEFEEDTOKEN",
    );
    expect(result).not.toContain("FAKEFEEDTOKEN");
    expect(result).toContain("Could not fetch de-vbb");
  });

  it("strips FTP userinfo", () => {
    const result = scrubSecrets("ftp://user:FAKEPASS@ftp.example.org/feed.zip");
    expect(result).not.toContain("FAKEPASS");
    expect(result).toContain("ftp://ftp.example.org/feed.zip");
  });

  it("is idempotent", () => {
    const message =
      "curl https://feeds.example.org/key/FAKEKEY/x.zip?token=FAKETOKEN Authorization: Bearer FAKEBEARER";
    expect(scrubSecrets(scrubSecrets(message))).toBe(scrubSecrets(message));
  });

  it("preserves non-secret text verbatim", () => {
    const message = "Could not fetch de-vbb: connection refused";
    expect(scrubSecrets(message)).toBe(message);
  });

  it("returns empty input unchanged", () => {
    expect(scrubSecrets("")).toBe("");
  });

  it("returns undefined from the optional helper", () => {
    expect(scrubSecretsOptional(undefined)).toBeUndefined();
  });
});
