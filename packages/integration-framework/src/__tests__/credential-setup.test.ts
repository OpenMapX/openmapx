import { describe, expect, it } from "vitest";
import { readCredentialSetup } from "../manifest";

describe("readCredentialSetup", () => {
  it("parses a full x-openmapx-setup block off a property def", () => {
    const setup = readCredentialSetup({
      type: "string",
      "x-openmapx-secret": true,
      "x-openmapx-setup": {
        url: "https://provider.example/account/keys",
        urlLabel: "Open dashboard",
        steps: ["Create an account.", "Copy the key."],
        cost: "Free up to 100k req/mo",
        notes: "Activation takes a few minutes.",
        email: {
          to: "api@provider.example",
          subject: "API access request",
          body: "Hello,\n\nPlease grant access.",
        },
      },
    });
    expect(setup).toEqual({
      url: "https://provider.example/account/keys",
      urlLabel: "Open dashboard",
      steps: ["Create an account.", "Copy the key."],
      cost: "Free up to 100k req/mo",
      notes: "Activation takes a few minutes.",
      email: {
        to: "api@provider.example",
        subject: "API access request",
        body: "Hello,\n\nPlease grant access.",
      },
    });
  });

  it("returns undefined when the block is absent", () => {
    expect(readCredentialSetup({ type: "string", "x-openmapx-secret": true })).toBeUndefined();
  });

  it("returns undefined for non-object property defs", () => {
    expect(readCredentialSetup(null)).toBeUndefined();
    expect(readCredentialSetup("nope")).toBeUndefined();
  });

  it("rejects a malformed block (wrong types)", () => {
    expect(
      readCredentialSetup({ "x-openmapx-setup": { steps: "should-be-an-array" } }),
    ).toBeUndefined();
    expect(
      readCredentialSetup({ "x-openmapx-setup": { email: { subject: "missing-to" } } }),
    ).toBeUndefined();
  });

  it("accepts a minimal url-only block", () => {
    expect(readCredentialSetup({ "x-openmapx-setup": { url: "https://x.example" } })).toEqual({
      url: "https://x.example",
    });
  });
});
