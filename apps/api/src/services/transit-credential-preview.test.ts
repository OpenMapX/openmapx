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

it("binds the proposed catalog selector without changing legacy active-preview intent", () => {
  const base = {
    previewId: "opaque",
    actorId: "admin",
    catalogRevisionId: "catalog",
    credentialsRevision: "private-row-version",
    expectedCurrentRevisionId: null,
    changes: [{ key: "de/a", action: "set" as const, value: "private-value" }],
  };
  const first = { ...base, proposalId: "00000000-0000-4000-8000-000000000001" };
  expect(feedCredentialIntent(first)).not.toBe(feedCredentialIntent(base));
  expect(feedCredentialIntent(first)).not.toBe(
    feedCredentialIntent({ ...first, proposalId: "00000000-0000-4000-8000-000000000002" }),
  );
  expect(feedCredentialIntent({ ...base, proposalId: undefined })).toBe(feedCredentialIntent(base));
});
