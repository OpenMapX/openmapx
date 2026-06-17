import { describe, expect, it, vi } from "vitest";

// admin-cli.ts destructures @openmapx/core/server at module load; stub it so the
// test exercises only the pure validator without the real service registry.
vi.mock("@openmapx/core/server", () => ({
  services: {},
  findRepoRoot: () => "/repo",
  repoPaths: () => ({ infraDir: "/repo/infra/docker" }),
}));

const { assertValidBackupName } = await import("../admin-cli");

describe("assertValidBackupName", () => {
  it("accepts alphanumerics, dot, underscore, and hyphen", () => {
    for (const name of ["my-backup", "backup_2026.01.01", "ABC123", "a.b-c_d"]) {
      expect(() => assertValidBackupName(name)).not.toThrow();
    }
  });

  it("rejects path separators, whitespace, and shell metacharacters", () => {
    for (const name of [
      "slash/name",
      "with space",
      "semi;colon",
      "dollar$x",
      "tick`x`",
      "quote'x",
      "",
    ]) {
      expect(() => assertValidBackupName(name)).toThrow(/Invalid backup name/);
    }
  });

  it("rejects a name containing a newline", () => {
    expect(() => assertValidBackupName("line1\nline2")).toThrow(/Invalid backup name/);
  });
});
