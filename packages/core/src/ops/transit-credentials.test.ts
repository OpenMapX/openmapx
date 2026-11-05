import { expect, it } from "vitest";
import { authorizeOpsOperation, opsOperationSchema, parseOpsResult } from "./contract";

it("offers a read-only API inspection tied to one exact catalog, without credential values", () => {
  const input = { kind: "transitCredentials.inspect", catalogRevisionId: "a".repeat(64) };
  expect(opsOperationSchema.safeParse(input).success).toBe(true);
  expect(authorizeOpsOperation("api", "transitCredentials.inspect")).toBe(true);
  expect(authorizeOpsOperation("data-manager", "transitCredentials.inspect")).toBe(false);
  expect(opsOperationSchema.safeParse({ ...input, path: "/etc/passwd" }).success).toBe(false);
  const result = {
    catalogRevisionId: input.catalogRevisionId,
    requiredKeys: ["de/provider"],
    owner: "unset",
    editable: true,
    reason: null,
    configuredKeys: [],
    retainedKeys: [],
    appliedCredentialsRevision: null,
    hostCredentialsRevision: null,
  };
  expect(parseOpsResult("transitCredentials.inspect", result)).toEqual(result);
  expect(() =>
    parseOpsResult("transitCredentials.inspect", {
      ...result,
      values: { "de/provider": "sensitive" },
    }),
  ).toThrow();
});
it("denies fresh execution of the retired remote file generator for every caller role", () => {
  expect(authorizeOpsOperation("api", "data.generateApiKeys")).toBe(false);
  expect(authorizeOpsOperation("data-manager", "data.generateApiKeys")).toBe(false);
});
