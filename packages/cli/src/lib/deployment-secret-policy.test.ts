import { describe, expect, it } from "vitest";
import {
  assertPostgresDeploymentSecret,
  assertProductionDatabaseUrlSecret,
  deploymentSecretIssue,
  POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH,
} from "./deployment-secret-policy";

describe("deploymentSecretIssue", () => {
  it.each([undefined, "", "   ", "\t\n"])("rejects missing input %#", (value) => {
    expect(deploymentSecretIssue(value, { minLength: POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH })).toBe(
      "missing",
    );
  });

  it.each([
    "change-me",
    "CHANGE-ME",
    "changeme",
    "ChangeMe",
    "replace-me",
    "REPLACE-ME",
    "password",
    "PASSWORD",
    "postgres",
    "Postgres",
    "openmapx",
    "OpenMapX",
  ])("rejects the known placeholder %s case-insensitively", (value) => {
    expect(deploymentSecretIssue(value, { minLength: POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH })).toBe(
      "known-placeholder",
    );
  });

  it("rejects a password equal to the configured username", () => {
    const username = "production_database_owner";
    expect(
      deploymentSecretIssue(username, {
        username,
        minLength: POSTGRES_DEPLOYMENT_SECRET_MIN_LENGTH,
      }),
    ).toBe("matches-username");
  });

  it("enforces the 23/24-character boundary without character-class rules", () => {
    expect(deploymentSecretIssue("x".repeat(23), { minLength: 24 })).toBe("too-short");
    expect(deploymentSecretIssue("x".repeat(24), { minLength: 24 })).toBeNull();
  });

  it("evaluates the URL-decoded credential", () => {
    expect(deploymentSecretIssue("change%2Dme", { minLength: 24 })).toBe("known-placeholder");
    expect(
      deploymentSecretIssue("database%5Fowner", {
        username: "database_owner",
        minLength: 8,
      }),
    ).toBe("matches-username");
  });
});

describe("deployment secret assertions", () => {
  it("never includes the rejected value in a direct-password error", () => {
    const rejected = "private-fixture-value";

    expect(() => assertPostgresDeploymentSecret(rejected)).toThrow(/too-short/);
    try {
      assertPostgresDeploymentSecret(rejected);
    } catch (error) {
      expect((error as Error).message).not.toContain(rejected);
    }
  });

  it("validates a decoded database URL password without revealing the URL", () => {
    const databaseUrl = "postgresql://database_owner:change%2Dme@database.invalid/openmapx";

    expect(() => assertProductionDatabaseUrlSecret(databaseUrl, "production")).toThrow(
      /known-placeholder/,
    );
    try {
      assertProductionDatabaseUrlSecret(databaseUrl, "production");
    } catch (error) {
      expect((error as Error).message).not.toContain(databaseUrl);
      expect((error as Error).message).not.toContain("change-me");
    }
  });

  it("does not enforce production deployment strength in local or test environments", () => {
    expect(() =>
      assertProductionDatabaseUrlSecret(
        "postgresql://postgres:postgres@localhost:5432/openmapx",
        "test",
      ),
    ).not.toThrow();
  });
});
