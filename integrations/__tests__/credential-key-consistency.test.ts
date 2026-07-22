import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_KEYED_INTEGRATIONS,
  checkCredentialKey,
  collectCredentialKeyViolations,
  credentialKeysOf,
  loadManifest,
} from "../../scripts/check-credential-keys";

// vitest runs from the repo root, so process.cwd() is the repo root here.
const REPO_ROOT = process.cwd();

describe("credential-key consistency", () => {
  it("has no credential-key violations across the six embedded-provider manifests", () => {
    expect(collectCredentialKeyViolations(REPO_ROOT)).toEqual([]);
  });

  it("every credential key of the six governed integrations is a real <sourceId>-<field> composition", () => {
    let checked = 0;
    for (const integrationId of CREDENTIAL_KEYED_INTEGRATIONS) {
      const loaded = loadManifest(integrationId);
      expect(loaded, `${integrationId}: manifest.json should load`).toBeTruthy();
      if (!loaded) continue;

      const sourceIds = new Set((loaded.manifest.dataSources ?? []).map((ds) => ds.sourceId));
      expect(
        sourceIds.size,
        `${integrationId}: should declare at least one dataSources sourceId`,
      ).toBeGreaterThan(0);

      const keys = credentialKeysOf(loaded.manifest);
      expect(
        keys.length,
        `${integrationId}: should declare at least one credential key`,
      ).toBeGreaterThan(0);
      for (const key of keys) {
        checked++;
        expect(
          checkCredentialKey(integrationId, key, sourceIds),
          `${integrationId}: "${key}" should be a valid <sourceId>-<field> composition`,
        ).toBeUndefined();
      }
    }
    // Guards against the loop above silently checking zero keys (e.g. a
    // stale integration list or a manifest-loading regression that made
    // every `loaded` falsy) and the test passing for the wrong reason.
    expect(checked).toBeGreaterThan(20);
  });

  it("rejects a key that only shares a hyphenated prefix with a sourceId instead of composing exactly", () => {
    // "dot-ga" is a real webcam sourceId; "dot-gaa-api-key" is NOT the exact
    // composition dot-ga + "-" + api-key, even though it shares the "dot-ga"
    // prefix. A startsWith-based (rather than exact-composition) check would
    // wrongly accept this.
    const sourceIds = new Set(["dot-ga"]);
    expect(checkCredentialKey("webcam", "dot-gaa-api-key", sourceIds)).toBeDefined();
    expect(checkCredentialKey("webcam", "dot-ga-api-key", sourceIds)).toBeUndefined();
  });

  it("rejects a credential key with disallowed characters or casing", () => {
    const sourceIds = new Set(["ocm"]);
    expect(checkCredentialKey("ev-charging", "ocm_api_key", sourceIds)).toBeDefined();
    expect(checkCredentialKey("ev-charging", "ocmApiKey", sourceIds)).toBeDefined();
  });

  it("rejects a credential key composed with a field outside the allowed set", () => {
    const sourceIds = new Set(["ocm"]);
    expect(checkCredentialKey("ev-charging", "ocm-secret", sourceIds)).toBeDefined();
  });

  it("ignores exempt single-provider integrations, even though their bare keys would fail the six-integration rule", () => {
    // geocoding-maptiler is a single-provider integration and is legitimately
    // NOT in CREDENTIAL_KEYED_INTEGRATIONS, so collectCredentialKeyViolations
    // never inspects it.
    expect(CREDENTIAL_KEYED_INTEGRATIONS as readonly string[]).not.toContain("geocoding-maptiler");

    const loaded = loadManifest("geocoding-maptiler");
    expect(loaded).toBeTruthy();
    if (!loaded) return;
    const sourceIds = new Set((loaded.manifest.dataSources ?? []).map((ds) => ds.sourceId));
    const keys = credentialKeysOf(loaded.manifest);
    expect(keys).toContain("apiKey");

    // Demonstrate the rule would in fact catch "apiKey" if this integration
    // were mistakenly added to the governed list — proving the exemption is
    // load-bearing, not just an accidental pass.
    for (const key of keys) {
      expect(checkCredentialKey("geocoding-maptiler", key, sourceIds)).toBeDefined();
    }
  });
});
