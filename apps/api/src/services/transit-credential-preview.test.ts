import { expect, it } from "vitest";
import { feedCredentialIntent } from "./transit-credential-preview";

it("public intent binds opaque preview identity and actions, never hashes a credential value", () => {
  const base = {
    previewId: "opaque-random-id",
    actorId: "admin",
    catalogRevisionId: "catalog",
    credentialsRevision: "random-encrypted-row",
    expectedCurrentRevisionId: null,
    changes: [{ key: "de/a", action: "set" as const, value: "first" }],
  };
  expect(feedCredentialIntent(base)).toBe(
    feedCredentialIntent({ ...base, changes: [{ ...base.changes[0]!, value: "second" }] }),
  );
  expect(feedCredentialIntent(base)).not.toBe(
    feedCredentialIntent({ ...base, previewId: "another-opaque-random-id" }),
  );
  expect(feedCredentialIntent(base)).not.toBe(
    feedCredentialIntent({ ...base, changes: [{ key: "de/a", action: "delete" }] }),
  );
});
