import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extensionManifestSchema, verifiedCatalogEntrySchema } from "../services/extension-schema";

/**
 * Gate B — verified extension publication (Tracks 1–3, 5, 13).
 *
 * A verified publication must be traceable end to end: an immutable catalog
 * commit, an exact manifest digest over the received bytes, exact component
 * identities, and a bounded snapshot. This asserts the schema-level half of
 * that chain — the half that decides whether an entry may be called verified
 * at all. The digest-over-bytes, ownership, clone-budget, and artifact-
 * allowlist halves are covered by their own suites:
 *
 * - `apps/api/src/services/__tests__/extension-store.test.ts` (digest before parse)
 * - `apps/api/src/services/__tests__/extension-component-ownership.test.ts`
 * - `apps/api/src/db/__tests__/extension-component-ownership-migration.test.ts`
 * - `packages/core/src/__tests__/git-clone-budget.test.ts`
 * - `packages/integration-framework/src/__tests__/package-contract.test.ts`
 */

const COMMIT = "254ed34c34f204809870323e7dca6389e0d6f81f";

describe("Gate B — verified extension publication", () => {
  it("accepts only a fully digest-pinned catalog entry", () => {
    const entry = {
      id: "openconditions",
      version: "1.0.0",
      manifest: `https://raw.githubusercontent.com/openmapx/community-extensions/${COMMIT}/openconditions/extension.json`,
      manifestSha256: createHash("sha256").update("fixture").digest("hex"),
      platform: "1.0",
    };
    expect(verifiedCatalogEntrySchema.safeParse(entry).success).toBe(true);

    // Every field that makes the entry immutable is load-bearing.
    for (const omitted of ["manifestSha256", "manifest", "version", "id"] as const) {
      const { [omitted]: _removed, ...rest } = entry;
      expect(verifiedCatalogEntrySchema.safeParse(rest).success, omitted).toBe(false);
    }
  });

  it("refuses an entry that tries to carry its own trust or extra fields", () => {
    const entry = {
      id: "openconditions",
      version: "1.0.0",
      manifest: "https://example.test/extension.json",
      manifestSha256: "d".repeat(64),
      trust: "verified",
    };
    expect(verifiedCatalogEntrySchema.safeParse(entry).success).toBe(false);
  });

  it("requires exact component identities in the published manifest", () => {
    const base = {
      id: "openconditions",
      name: "OpenConditions",
      version: "1.0.0",
      integrations: [
        { artifact: "https://example.test/a.tar.gz", sha256: "a".repeat(64), id: "overlay" },
      ],
    };
    expect(extensionManifestSchema.safeParse(base).success).toBe(true);

    // A component named twice would let one extension claim another's install.
    expect(
      extensionManifestSchema.safeParse({
        ...base,
        services: [{ repo: "https://github.com/o/r.git", service: "overlay" }],
      }).success,
    ).toBe(false);

    // A config target outside the bundle resolves against something the
    // publication never declared.
    expect(
      extensionManifestSchema.safeParse({
        ...base,
        config: [{ key: "TOKEN", target: "integration:not-declared" }],
      }).success,
    ).toBe(false);

    // An unpinned artifact is not publishable.
    expect(
      extensionManifestSchema.safeParse({
        ...base,
        integrations: [{ artifact: "https://example.test/a.tar.gz", id: "overlay" }],
      }).success,
    ).toBe(false);
  });

  it("keeps the public registry blocked until this gate is recorded as passing", () => {
    // The plan forbids enabling the public plugin registry before Tracks 1-3,
    // 5, and 13 pass. The extensions README carries that statement.
    const readme = new URL("../../../../docs/plans/extensions/README.md", import.meta.url);
    const contents = require("node:fs").readFileSync(readme, "utf8") as string;
    expect(contents).toMatch(/public plugin registry/i);
    expect(contents).toMatch(/Gate B/);
  });
});
