import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATED_SECRETS_DIR, regenerateServiceSecretFiles } from "../service-secret-files";

describe("regenerateServiceSecretFiles", () => {
  let infraDir: string;
  const root = () => join(infraDir, GENERATED_SECRETS_DIR);
  const file = (svc: string, key: string) => join(root(), svc, key);

  beforeEach(() => {
    infraDir = mkdtempSync(join(tmpdir(), "omx-secrets-"));
  });
  afterEach(() => {
    rmSync(infraDir, { recursive: true, force: true });
  });

  it("writes each secret value to its own file", () => {
    regenerateServiceSecretFiles(
      infraDir,
      new Map([["ingest", { NY_511_API_KEY: "abc", LTA_ACCOUNT_KEY: "xyz" }]]),
    );
    expect(readFileSync(file("ingest", "NY_511_API_KEY"), "utf8")).toBe("abc");
    expect(readFileSync(file("ingest", "LTA_ACCOUNT_KEY"), "utf8")).toBe("xyz");
  });

  it("removes a file for a credential that is no longer present (no stale secrets)", () => {
    regenerateServiceSecretFiles(
      infraDir,
      new Map([["ingest", { NY_511_API_KEY: "abc", LTA_ACCOUNT_KEY: "xyz" }]]),
    );
    // Re-render with LTA removed — the file must be gone, not left behind.
    regenerateServiceSecretFiles(infraDir, new Map([["ingest", { NY_511_API_KEY: "abc" }]]));
    expect(existsSync(file("ingest", "NY_511_API_KEY"))).toBe(true);
    expect(existsSync(file("ingest", "LTA_ACCOUNT_KEY"))).toBe(false);
  });

  it("wipes the whole tree when the last credential is removed", () => {
    regenerateServiceSecretFiles(infraDir, new Map([["ingest", { NY_511_API_KEY: "abc" }]]));
    regenerateServiceSecretFiles(infraDir, new Map());
    expect(existsSync(root())).toBe(false);
  });

  it("updates a rotated value in place", () => {
    regenerateServiceSecretFiles(infraDir, new Map([["ingest", { NY_511_API_KEY: "old" }]]));
    regenerateServiceSecretFiles(infraDir, new Map([["ingest", { NY_511_API_KEY: "new" }]]));
    expect(readFileSync(file("ingest", "NY_511_API_KEY"), "utf8")).toBe("new");
  });

  it("throws on a traversal-shaped key instead of writing outside the service directory", () => {
    expect(() =>
      regenerateServiceSecretFiles(infraDir, new Map([["ingest", { "../../escaped": "x" }]])),
    ).toThrow(/Invalid credential key/);
    expect(existsSync(join(infraDir, "escaped"))).toBe(false);
  });

  it("writes secret files world-readable (0444) so a non-root container user can read the Compose-mounted secret", () => {
    regenerateServiceSecretFiles(infraDir, new Map([["ingest", { NY_511_API_KEY: "abc" }]]));
    expect(statSync(file("ingest", "NY_511_API_KEY")).mode & 0o777).toBe(0o444);
  });
});
