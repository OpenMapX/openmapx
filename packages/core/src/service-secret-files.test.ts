import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readServiceSecretFile, resolveDatabaseUrl } from "./service-secret-files";

const directories: string[] = [];
function secretFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-service-secret-"));
  directories.push(directory);
  const path = join(directory, "secret");
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("service secret files", () => {
  it("reads the secret alone and tolerates one trailing newline", () => {
    expect(readServiceSecretFile(secretFile("value"), "Test")).toBe("value");
    expect(readServiceSecretFile(secretFile("value\n"), "Test")).toBe("value");
  });

  it("refuses missing, empty, padded, linked and oversized files", () => {
    expect(() => readServiceSecretFile("/nonexistent/secret", "Test")).toThrow(
      "Test file is missing or unreadable",
    );
    expect(() => readServiceSecretFile(secretFile(""), "Test")).toThrow("alone");
    expect(() => readServiceSecretFile(secretFile(" value"), "Test")).toThrow("alone");
    const link = join(directories[0] ?? tmpdir(), "link");
    symlinkSync(secretFile("value"), link);
    expect(() => readServiceSecretFile(link, "Test")).toThrow("missing or unreadable");
    expect(() => readServiceSecretFile(secretFile("x".repeat(4097)), "Test")).toThrow("size limit");
  });
});

describe("resolveDatabaseUrl", () => {
  const fallback = "postgresql://postgres:postgres@localhost:5432/openmapx";

  it("uses the URL as given without a password file", () => {
    expect(resolveDatabaseUrl(fallback, {})).toBe(fallback);
    expect(resolveDatabaseUrl(fallback, { DATABASE_URL: "postgresql://a:b@db/x" })).toBe(
      "postgresql://a:b@db/x",
    );
  });

  it("adds the role's password from the file, percent-encoded", () => {
    const url = resolveDatabaseUrl(fallback, {
      DATABASE_URL: "postgresql://openmapx_api@postgis:5432/openmapx",
      DATABASE_PASSWORD_FILE: secretFile("p@ss/word"),
    });
    const parsed = new URL(url);
    expect(parsed.username).toBe("openmapx_api");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/word");
    expect(parsed.host).toBe("postgis:5432");
    expect(parsed.pathname).toBe("/openmapx");
  });

  it("refuses a URL that already has a password or names no role", () => {
    const passwordFile = secretFile("secret");
    expect(() =>
      resolveDatabaseUrl(fallback, {
        DATABASE_URL: "postgresql://openmapx_api:other@postgis/openmapx",
        DATABASE_PASSWORD_FILE: passwordFile,
      }),
    ).toThrow("must not carry a password");
    expect(() =>
      resolveDatabaseUrl(fallback, {
        DATABASE_URL: "postgresql://postgis/openmapx",
        DATABASE_PASSWORD_FILE: passwordFile,
      }),
    ).toThrow("must name the role");
  });
});
