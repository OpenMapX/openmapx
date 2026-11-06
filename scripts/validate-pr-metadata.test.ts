import { describe, expect, it } from "vitest";
import { validatePrMetadata } from "./validate-pr-metadata.mjs";

const original = {
  number: 12,
  head: { sha: "a".repeat(40) },
  base: { sha: "b".repeat(40), ref: "main" },
  body: "Product impact: none",
  title: "ci: improve validation",
};

describe("trusted PR metadata validation", () => {
  it("validates current metadata against immutable Git objects, never a candidate checkout", async () => {
    const actions: unknown[] = [];
    await validatePrMetadata(
      { repository: "OpenMapX/openmapx", number: 12, head: original.head.sha },
      {
        read: async () => original,
        fetch: async (...args: unknown[]) => {
          actions.push(args);
        },
        validate: async (...args: unknown[]) => {
          actions.push(args);
        },
      },
    );
    expect(actions).toEqual([[12, original.base.sha, original.head.sha], [original]]);
  });
  it("fails if classification changes while validation is running", async () => {
    let reads = 0;
    await expect(
      validatePrMetadata(
        { repository: "OpenMapX/openmapx", number: 12, head: original.head.sha },
        {
          read: async () => (++reads === 1 ? original : { ...original, body: "changed" }),
          fetch: async () => {},
          validate: async () => {},
        },
      ),
    ).rejects.toThrow(/changed/);
  });
  it.each(["head", "base"])("rejects %s identity races before validating", async (field) => {
    const changed = { ...original, [field]: { sha: "main" } };
    await expect(
      validatePrMetadata(
        { repository: "OpenMapX/openmapx", number: 12, head: original.head.sha },
        {
          read: async () => changed,
          fetch: async () => {
            throw Error("must not fetch");
          },
          validate: async () => {
            throw Error("must not execute");
          },
        },
      ),
    ).rejects.toThrow(/identity/);
  });
  it("propagates invalid release classification", async () => {
    await expect(
      validatePrMetadata(
        { repository: "OpenMapX/openmapx", number: 12, head: original.head.sha },
        {
          read: async () => original,
          fetch: async () => {},
          validate: async () => {
            throw Error("Missing classification");
          },
        },
      ),
    ).rejects.toThrow("Missing classification");
  });
});
