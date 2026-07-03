import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import {
  demoteUserFromAdmin,
  execPsql,
  listUsers,
  markEmailVerified,
  promoteUserToAdmin,
} from "../src/commands/users";

const mockExeca = vi.mocked(execa);

let tmp: string;

function writePostgisManifest() {
  const dir = join(tmp, "services", "postgis");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "service.json"),
    JSON.stringify({
      id: "postgis",
      name: "PostGIS",
      version: "1.0.0",
      quality: "built-in",
      container: {
        image: "t/x",
        tag: "latest",
        expose: [5432],
        environment: { POSTGRES_USER: "omx", POSTGRES_DB: "openmapx" },
      },
    }),
    "utf-8",
  );
}

function lastArgs(): string[] {
  const call = mockExeca.mock.calls.at(-1);
  return (call?.[1] as string[]) ?? [];
}

function lastSql(): string {
  const args = lastArgs();
  return args[args.length - 1] ?? "";
}

beforeEach(() => {
  delete process.env.OPENMAPX_ROOT_DIR;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-users-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  writePostgisManifest();
  mockExeca.mockResolvedValue({ exitCode: 0, stdout: "user-id-1\n", stderr: "" } as never);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("user mutation commands", () => {
  it("promotes a user with the resolved postgres target and CTE update SQL", async () => {
    await promoteUserToAdmin("a@b.test", tmp);

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const call = mockExeca.mock.calls[0];
    expect(call[0]).toBe("docker");
    const args = call[1] as string[];
    for (const token of [
      "compose",
      "-f",
      "exec",
      "-T",
      "postgis",
      "psql",
      "-U",
      "omx",
      "-d",
      "openmapx",
      "-c",
    ]) {
      expect(args).toContain(token);
    }
    // args order: -U omx, -d openmapx
    expect(args.indexOf("-U")).toBeLessThan(args.indexOf("omx"));
    expect(args.indexOf("-d")).toBeLessThan(args.indexOf("openmapx"));
    const sql = lastSql();
    expect(sql.startsWith('WITH updated AS (UPDATE "user" SET')).toBe(true);
    expect(sql).toContain("role = 'admin'");
    expect(sql).toContain("email = 'a@b.test'");
  });

  it("demotes with role = 'user'", async () => {
    await demoteUserFromAdmin("a@b.test", tmp);
    expect(lastSql()).toContain("role = 'user'");
  });

  it("marks email verified", async () => {
    await markEmailVerified("a@b.test", tmp);
    expect(lastSql()).toContain("email_verified = true");
  });

  it("escapes single quotes in the SQL literal", async () => {
    await promoteUserToAdmin("o'brien@b.test", tmp);
    const sql = lastSql();
    expect(sql).toContain("'o''brien@b.test'");
    expect(sql).not.toContain("'o'brien@b.test'");
  });

  it("rejects an invalid email before touching docker", async () => {
    await expect(promoteUserToAdmin("not-an-email", tmp)).rejects.toThrow(
      /does not look like an email address/,
    );
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it("rejects when no user matched", async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    await expect(promoteUserToAdmin("a@b.test", tmp)).rejects.toThrow(/No user found with email/);
  });

  it("proceeds with a warning when multiple users match", async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "id-1\nid-2\n", stderr: "" } as never);
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(promoteUserToAdmin("a@b.test", tmp)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("execPsql / listUsers", () => {
  it("throws with the exit code and stderr when psql fails", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "connection refused",
    } as never);
    await expect(
      execPsql({ serviceId: "postgis", user: "omx", db: "openmapx" }, "SELECT 1;", tmp),
    ).rejects.toThrow(/psql failed \(exit 1\)/);
    await expect(
      execPsql({ serviceId: "postgis", user: "omx", db: "openmapx" }, "SELECT 1;", tmp),
    ).rejects.toThrow(/connection refused/);
  });

  it("parses pipe-delimited user rows", async () => {
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: "id-1|a@b.test|Alice|admin\nid-2|c@d.test||\n",
      stderr: "",
    } as never);
    const rows = await listUsers(tmp);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: "id-1", email: "a@b.test", name: "Alice", role: "admin" });
    expect(rows[1]).toEqual({ id: "id-2", email: "c@d.test", name: "", role: "" });
  });
});
